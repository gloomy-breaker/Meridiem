/**
 * DeepSeek Search & Fetch
 *
 * Adds two tools backed by DeepSeek's raw JSON APIs:
 *   - `deepseek_search` -> POST {base}/v1/tools/search
 *   - `deepseek_fetch`  -> POST {base}/v1/tools/fetch
 *
 * This file is inlined into Meridiem's main bundle (`?raw`) and written into the
 * app's agent dir at session start, where pi's DefaultResourceLoader discovers
 * `<agentDir>/extensions/*.ts` like any other extension. It is app-owned: edits
 * made in `<userData>/agent/extensions/deepseek-search.ts` are overwritten on the
 * next agent start, so change this file instead.
 *
 * The same source also runs under the plain pi CLI when copied to
 * `~/.pi/agent/extensions/deepseek-search.ts` (keep the two in sync).
 *
 * Without a DeepSeek key the extension registers nothing (see the default export).
 *
 * Docs: https://api-docs.deepseek.com/api/search/ and https://api-docs.deepseek.com/api/fetch/
 *
 * Auth (first match wins):
 *   1. $DEEPSEEK_SEARCH_API_KEY
 *   2. $DEEPSEEK_API_KEY
 *   3. auth.json -> { "deepseek": { "key": "..." } }, looked up in:
 *        $DEEPSEEK_SEARCH_AUTH_FILE
 *        $YESTION_AGENT_DIR/auth.json   (set by the Meridiem app: userData/agent)
 *        $PI_CODING_AGENT_DIR/auth.json (default ~/.pi/agent/auth.json)
 *
 * Base URL: $DEEPSEEK_SEARCH_BASE_URL, else the `deepseek` provider's baseUrl from
 * models.json in the same dirs (a trailing /v1 is stripped: the tool paths already
 * carry it), else https://api.deepseek.com.
 *
 * Notes:
 *   - Search and Fetch are billed per successful request ($0.75 / 1000), so results are
 *     briefly cached in-session, and count does not change the price.
 *   - Account-level QPS limit is 5, so requests are serialized with a small gap and
 *     retried on 408/429/5xx.
 *   - Tool output is truncated to pi's standard limits; full output is saved to a temp file.
 */

import { readFileSync } from "node:fs";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, TruncationResult } from "@earendil-works/pi-coding-agent";
import {
	DEFAULT_MAX_BYTES,
	DEFAULT_MAX_LINES,
	formatSize,
	getAgentDir,
	truncateHead,
	withFileMutationQueue,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";

const DEFAULT_BASE_URL = "https://api.deepseek.com";
const SEARCH_PATH = "/v1/tools/search";
const FETCH_PATH = "/v1/tools/fetch";

const REQUEST_TIMEOUT_MS = 60_000;
/** Account QPS limit is 5 for both Search and Fetch. */
const MIN_REQUEST_GAP_MS = 250;
const MAX_ATTEMPTS = 3;
const MAX_CONTENT_CHARS_PER_RESULT = 8_000;
const CACHE_TTL_MS = 5 * 60_000;
const CACHE_MAX_ENTRIES = 50;

/** ------------------------------------------------------------------ types */

interface SearchResultItem {
	rerank_score: number;
	title: string;
	url: string;
	snippet: string;
	summary: string;
	content: string;
	site_name: string | null;
	site_icon: string | null;
	date: string | null;
	authority: number;
}

interface SearchResponse {
	results: SearchResultItem[];
}

interface FetchResponse {
	title: string;
	content: string;
}

interface SearchDetails {
	query: string;
	requestedCount: number;
	resultCount: number;
	cached: boolean;
	needContent: boolean;
	results: Array<{
		title: string;
		url: string;
		siteName: string | null;
		date: string | null;
		authority: number;
		rerankScore: number;
		snippet: string;
		summary: string;
	}>;
	truncation?: TruncationResult;
	fullOutputPath?: string;
}

interface FetchDetails {
	url: string;
	title: string;
	chars: number;
	truncation?: TruncationResult;
	fullOutputPath?: string;
}

class DeepSeekApiError extends Error {
	constructor(
		readonly status: number,
		message: string,
	) {
		super(message);
		this.name = "DeepSeekApiError";
	}
}

/** ------------------------------------------------------------------ config */

/**
 * Config dirs to search, most specific first. `YESTION_AGENT_DIR` is set by the
 * Meridiem desktop app (its provider store lives in `userData/agent`, not `~/.pi/agent`).
 */
function configDirs(): string[] {
	const dirs = [process.env.DEEPSEEK_SEARCH_AGENT_DIR, process.env.YESTION_AGENT_DIR, getAgentDir()]
		.map((dir) => dir?.trim())
		.filter((dir): dir is string => Boolean(dir));
	return [...new Set(dirs)];
}

function readJsonFile<T>(path: string): T | undefined {
	try {
		return JSON.parse(readFileSync(path, "utf8")) as T;
	} catch {
		return undefined;
	}
}

interface PiModelsFile {
	providers?: Record<string, { baseUrl?: string } | undefined>;
}

function isDeepSeekHost(rawUrl: string): boolean {
	try {
		return /(^|\.)api\.deepseek\.com$/i.test(new URL(rawUrl.trim()).hostname);
	} catch {
		return false;
	}
}

/** `https://api.deepseek.com/v1` -> `https://api.deepseek.com`; the tool paths add `/v1` themselves. */
function normalizeBase(rawUrl: string): string {
	return rawUrl.trim().replace(/\/+$/, "").replace(/\/v1$/i, "");
}

/**
 * Provider ids that may hold a DeepSeek key: the usual ones plus whatever the
 * user named a custom provider pointed at api.deepseek.com.
 */
function deepseekProviderIds(): string[] {
	const ids = new Set<string>(["deepseek", "deepseek-cn"]);
	for (const dir of configDirs()) {
		const models = readJsonFile<PiModelsFile>(join(dir, "models.json"));
		for (const [id, provider] of Object.entries(models?.providers ?? {})) {
			if (provider?.baseUrl && isDeepSeekHost(provider.baseUrl)) ids.add(id);
		}
	}
	return [...ids];
}

function configBaseUrl(): string | undefined {
	const candidates: string[] = [];
	for (const dir of configDirs()) {
		const providers = readJsonFile<PiModelsFile>(join(dir, "models.json"))?.providers ?? {};
		// Preferred provider ids first, then any provider pointed at api.deepseek.com.
		for (const id of ["deepseek", "deepseek-cn"]) {
			const url = providers[id]?.baseUrl;
			if (url) candidates.push(url);
		}
		for (const provider of Object.values(providers)) {
			if (provider?.baseUrl && isDeepSeekHost(provider.baseUrl)) candidates.push(provider.baseUrl);
		}
	}
	return candidates[0];
}

function baseUrl(): string {
	const explicit = process.env.DEEPSEEK_SEARCH_BASE_URL?.trim() || process.env.DEEPSEEK_BASE_URL?.trim();
	return normalizeBase(explicit || configBaseUrl() || DEFAULT_BASE_URL);
}

function authFilePaths(): string[] {
	const explicit = process.env.DEEPSEEK_SEARCH_AUTH_FILE?.trim();
	const paths = explicit ? [explicit] : [];
	for (const dir of configDirs()) paths.push(join(dir, "auth.json"));
	return [...new Set(paths)];
}

function readKeyFromAuthFiles(): string | undefined {
	const providerIds = deepseekProviderIds();
	for (const path of authFilePaths()) {
		const auth = readJsonFile<Record<string, { type?: string; key?: string } | undefined>>(path);
		if (!auth) continue;
		for (const providerId of providerIds) {
			const key = auth[providerId]?.key;
			if (typeof key === "string" && key.trim()) return key.trim();
		}
	}
	return undefined;
}

function resolveApiKey(): string {
	const key =
		process.env.DEEPSEEK_SEARCH_API_KEY?.trim() ||
		process.env.DEEPSEEK_API_KEY?.trim() ||
		readKeyFromAuthFiles();
	if (!key) {
		throw new Error(
			`No DeepSeek API key found. Set DEEPSEEK_SEARCH_API_KEY (or DEEPSEEK_API_KEY), ` +
				`add a DeepSeek key in Meridiem's Settings → Models, or add a "deepseek" key to one of: ` +
				`${authFilePaths().join(", ")}.`,
		);
	}
	return key;
}

function hasDeepSeekCredentials(): boolean {
	return Boolean(
		process.env.DEEPSEEK_SEARCH_API_KEY?.trim() ||
			process.env.DEEPSEEK_API_KEY?.trim() ||
			readKeyFromAuthFiles(),
	);
}

/** ------------------------------------------------------------------ helpers */

function abortedError(signal?: AbortSignal): Error {
	const reason = signal?.reason;
	if (reason instanceof Error) return reason;
	return new Error("Request aborted");
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
	if (ms <= 0) return Promise.resolve();
	return new Promise((resolve, reject) => {
		if (signal?.aborted) {
			reject(abortedError(signal));
			return;
		}
		const timer = setTimeout(() => {
			signal?.removeEventListener("abort", onAbort);
			resolve();
		}, ms);
		const onAbort = () => {
			clearTimeout(timer);
			reject(abortedError(signal));
		};
		signal?.addEventListener("abort", onAbort, { once: true });
	});
}

function requestSignal(signal?: AbortSignal): AbortSignal {
	const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
	if (!signal) return timeout;
	if (typeof AbortSignal.any === "function") return AbortSignal.any([signal, timeout]);

	// Fallback for runtimes without AbortSignal.any.
	const controller = new AbortController();
	const abort = () => {
		controller.abort(signal.reason ?? timeout.reason);
		cleanup();
	};
	const cleanup = () => {
		signal.removeEventListener("abort", abort);
		timeout.removeEventListener("abort", abort);
	};
	if (signal.aborted || timeout.aborted) {
		abort();
	} else {
		signal.addEventListener("abort", abort, { once: true });
		timeout.addEventListener("abort", abort, { once: true });
	}
	return controller.signal;
}

/** Serialize requests and keep at least MIN_REQUEST_GAP_MS between them (5 QPS account limit). */
let queueTail: Promise<unknown> = Promise.resolve();
let lastRequestAt = 0;

function withRateLimit<T>(task: () => Promise<T>, signal?: AbortSignal): Promise<T> {
	const run = queueTail.then(async () => {
		const wait = lastRequestAt + MIN_REQUEST_GAP_MS - Date.now();
		if (wait > 0) await sleep(wait, signal);
		lastRequestAt = Date.now();
		return task();
	});
	// Keep the chain alive even when a request rejects.
	queueTail = run.catch(() => undefined);
	return run;
}

function isRetryableStatus(status: number): boolean {
	return status === 408 || status === 425 || status === 429 || status >= 500;
}

function backoffMs(attempt: number): number {
	return Math.min(4_000, 500 * 2 ** (attempt - 1));
}

function statusHint(status: number): string {
	switch (status) {
		case 400:
			return "invalid request (check the query/URL or field values)";
		case 401:
			return "API key missing or invalid";
		case 402:
			return "DeepSeek account has insufficient balance";
		case 403:
			return "rejected by the Fetch security policy";
		case 404:
			return "the page could not be retrieved (unavailable URL, blocked by site policy, or no extractable content)";
		case 408:
			return "request body read timed out";
		case 413:
			return "request body too large";
		case 429:
			return "rate limit exceeded (QPS 5 per account)";
		case 500:
			return "internal server error";
		case 504:
			return "downstream request timed out";
		default:
			return "unexpected error";
	}
}

function extractErrorMessage(raw: string): string | undefined {
	const trimmed = raw.trim();
	if (!trimmed) return undefined;
	try {
		const parsed = JSON.parse(trimmed) as { error?: { message?: unknown; code?: unknown } };
		const message = parsed.error?.message;
		if (typeof message === "string" && message.trim()) return message.trim();
	} catch {
		// not JSON
	}
	return trimmed.length > 300 ? `${trimmed.slice(0, 300)}…` : trimmed;
}

async function postJson<T>(path: string, body: unknown, signal?: AbortSignal): Promise<T> {
	const apiKey = resolveApiKey();
	const url = `${baseUrl()}${path}`;
	let lastError: unknown;

	for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
		if (signal?.aborted) throw abortedError(signal);

		let response: Response;
		try {
			response = await withRateLimit(
				() =>
					fetch(url, {
						method: "POST",
						headers: {
							Authorization: `Bearer ${apiKey}`,
							"Content-Type": "application/json",
						},
						body: JSON.stringify(body),
						signal: requestSignal(signal),
					}),
				signal,
			);
		} catch (error) {
			if (signal?.aborted) throw abortedError(signal);
			lastError = error instanceof Error ? error : new Error(String(error));
			if (attempt === MAX_ATTEMPTS) break;
			await sleep(backoffMs(attempt), signal);
			continue;
		}

		if (response.ok) {
			try {
				return (await response.json()) as T;
			} catch (error) {
				throw new Error(`DeepSeek returned a non-JSON response (HTTP ${response.status})`);
			}
		}

		const detail = extractErrorMessage(await response.text().catch(() => ""));
		const message = `DeepSeek ${path} failed: HTTP ${response.status} — ${statusHint(response.status)}${
			detail ? `: ${detail}` : ""
		}`;

		if (isRetryableStatus(response.status) && attempt < MAX_ATTEMPTS) {
			lastError = new DeepSeekApiError(response.status, message);
			const retryAfter = Number(response.headers.get("retry-after"));
			const delay = Number.isFinite(retryAfter) && retryAfter > 0 ? Math.min(5_000, retryAfter * 1_000) : backoffMs(attempt);
			await sleep(delay, signal);
			continue;
		}

		throw new DeepSeekApiError(response.status, message);
	}

	throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

/** Truncate tool output like the built-in tools, saving the full text to a temp file. */
async function finalizeOutput(
	text: string,
	label: string,
): Promise<{ text: string; truncation?: TruncationResult; fullOutputPath?: string }> {
	const truncation = truncateHead(text, { maxLines: DEFAULT_MAX_LINES, maxBytes: DEFAULT_MAX_BYTES });
	if (!truncation.truncated) return { text };

	const dir = await mkdtemp(join(tmpdir(), `pi-${label}-`));
	const fullOutputPath = join(dir, "output.txt");
	await withFileMutationQueue(fullOutputPath, async () => {
		await writeFile(fullOutputPath, text, "utf8");
	});

	const omittedLines = truncation.totalLines - truncation.outputLines;
	const omittedBytes = truncation.totalBytes - truncation.outputBytes;
	const notice =
		`\n\n[Output truncated: showing ${truncation.outputLines} of ${truncation.totalLines} lines ` +
		`(${formatSize(truncation.outputBytes)} of ${formatSize(truncation.totalBytes)}). ` +
		`${omittedLines} lines (${formatSize(omittedBytes)}) omitted. Full output saved to: ${fullOutputPath}]`;

	return { text: truncation.content + notice, truncation, fullOutputPath };
}

function oneLine(value: string | null | undefined): string {
	return (value ?? "").replace(/\s+/g, " ").trim();
}

function formatResultMeta(item: SearchResultItem): string {
	const bits: string[] = [];
	if (item.site_name) bits.push(`site: ${oneLine(item.site_name)}`);
	if (item.date) bits.push(`published: ${oneLine(item.date)}`);
	if (typeof item.authority === "number" && item.authority >= 0) bits.push(`authority: ${item.authority}/4`);
	if (typeof item.rerank_score === "number") bits.push(`relevance: ${item.rerank_score.toFixed(1)}/3`);
	return bits.join(" · ");
}

function formatSearchText(query: string, results: SearchResultItem[], needContent: boolean): string {
	if (results.length === 0) return `DeepSeek search returned no results for: "${query}"`;

	const lines: string[] = [`DeepSeek search results for: "${query}" (${results.length})`];
	results.forEach((item, index) => {
		lines.push("");
		lines.push(`[${index + 1}] ${oneLine(item.title) || "(untitled)"}`);
		lines.push(`url: ${item.url}`);
		const meta = formatResultMeta(item);
		if (meta) lines.push(meta);
		if (item.snippet) lines.push(`snippet: ${oneLine(item.snippet)}`);
		if (item.summary) lines.push(`summary: ${oneLine(item.summary)}`);
		if (needContent) {
			const content = item.content ?? "";
			if (!content.trim()) {
				lines.push("content: (unavailable)");
			} else if (content.length > MAX_CONTENT_CHARS_PER_RESULT) {
				lines.push(
					`content (first ${MAX_CONTENT_CHARS_PER_RESULT} of ${content.length} chars, use deepseek_fetch for the full page):`,
				);
				lines.push(content.slice(0, MAX_CONTENT_CHARS_PER_RESULT));
			} else {
				lines.push("content:");
				lines.push(content);
			}
		}
	});
	return lines.join("\n");
}

/** ------------------------------------------------------------------ cache */

const searchCache = new Map<string, { at: number; response: SearchResponse }>();

function cacheGet(key: string): SearchResponse | undefined {
	const hit = searchCache.get(key);
	if (!hit) return undefined;
	if (Date.now() - hit.at > CACHE_TTL_MS) {
		searchCache.delete(key);
		return undefined;
	}
	return hit.response;
}

function cacheSet(key: string, response: SearchResponse): void {
	if (searchCache.size >= CACHE_MAX_ENTRIES) {
		const oldest = searchCache.keys().next();
		if (!oldest.done) searchCache.delete(oldest.value);
	}
	searchCache.set(key, { at: Date.now(), response });
}

/** ------------------------------------------------------------------ tools */

export default function deepSeekToolsExtension(pi: ExtensionAPI) {
	// Without a DeepSeek key there is nothing to talk to, so stay out of the tool
	// list instead of offering tools that can only fail (a user who never
	// configured DeepSeek is not prompted to use a tool that errors on every
	// call). Keys are re-read on every load, so adding one later takes effect the
	// next time the agent starts or /reload runs.
	if (!hasDeepSeekCredentials()) return;

	pi.registerTool({
		name: "deepseek_search",
		label: "DeepSeek Search",
		description:
			"Search the live web with DeepSeek's search engine and return ranked results " +
			"(title, URL, site, publication date, authority tier, short snippet, long summary, optionally page content). " +
			"Query operators are supported: site:example.com, -site:example.com, \"exact phrase\", -term, " +
			"lang:zh,en, after:2025, before:2026-06-01 (join multiple site: clauses with OR). " +
			"Query must be 1-128 characters. Each call is billed as one request, so prefer one well-targeted query " +
			"over many near-duplicates. Content is only returned when needContent is true.",
		promptSnippet: "Search the live web via DeepSeek (POST /v1/tools/search)",
		promptGuidelines: [
			"Use deepseek_search when the answer depends on current web information (releases, versions, prices, news, docs) instead of relying on memory or local files.",
			"Use deepseek_fetch only on a specific URL that deepseek_search returned and whose full page text you actually need; set needContent only when you need page bodies for a few URLs.",
			"deepseek_search is billed per request, so batch related lookups into a single query with site:, lang:, after:, and quoted-phrase operators instead of issuing many similar searches.",
			"Never hand-roll a web search with bash and curl/python against search engines (Google, Bing, DuckDuckGo, Brave, Mojeek, searx/searxng instances): use deepseek_search, and deepseek_fetch to read a page. Scraping engines blocks, returns junk, and wastes the turn.",
		],
		parameters: Type.Object({
			query: Type.String({
				minLength: 1,
				maxLength: 128,
				description: "Search query, 1-128 characters. Supports site:, -site:, -term, \"exact phrase\", lang:, after:, before:.",
			}),
			count: Type.Optional(
				Type.Integer({ minimum: 1, maximum: 50, default: 10, description: "Number of results to return (1-50, default 10)." }),
			),
			needContent: Type.Optional(
				Type.Boolean({ default: false, description: "Also return page content for each result (heavier; default false)." }),
			),
			oriQuestion: Type.Optional(
				Type.String({
					minLength: 1,
					maxLength: 128,
					description: "The user's original question that triggered the search (improves query understanding).",
				}),
			),
			localization: Type.Optional(
				Type.String({ description: "Optional IP address used to localize search results, e.g. \"203.0.113.7\"." }),
			),
		}),

		async execute(_toolCallId, params, signal, onUpdate) {
			const query = params.query.trim();
			if (!query) throw new Error("deepseek_search requires a non-empty query.");
			const count = params.count ?? 10;
			const needContent = params.needContent ?? false;
			const oriQuestion = params.oriQuestion?.trim() || undefined;
			const localization = params.localization?.trim() || undefined;

			onUpdate?.({
				content: [{ type: "text", text: `Searching the web for "${query}"…` }],
				details: { query, requestedCount: count, resultCount: 0, cached: false, needContent, results: [] } as SearchDetails,
			});

			const body: Record<string, unknown> = { query, count, need_content: needContent };
			if (oriQuestion) body.ori_question = oriQuestion;
			if (localization) body.localization = localization;

			const cacheKey = JSON.stringify(body);
			let cached = true;
			let response = cacheGet(cacheKey);
			if (!response) {
				cached = false;
				response = await postJson<SearchResponse>(SEARCH_PATH, body, signal);
				if (Array.isArray(response.results)) cacheSet(cacheKey, response);
			}

			const results = Array.isArray(response.results) ? response.results : [];
			const formatted = formatSearchText(query, results, needContent);
			const output = await finalizeOutput(formatted, "deepseek-search");

			const details: SearchDetails = {
				query,
				requestedCount: count,
				resultCount: results.length,
				cached,
				needContent,
				results: results.map((item) => ({
					title: item.title,
					url: item.url,
					siteName: item.site_name,
					date: item.date,
					authority: item.authority,
					rerankScore: item.rerank_score,
					snippet: item.snippet,
					summary: item.summary,
				})),
				truncation: output.truncation,
				fullOutputPath: output.fullOutputPath,
			};

			return { content: [{ type: "text", text: output.text }], details };
		},

		renderCall(args, theme) {
			let text = theme.fg("toolTitle", theme.bold("deepseek_search "));
			text += theme.fg("accent", `"${oneLine(typeof args?.query === "string" ? args.query : "")}"`);
			const count = typeof args?.count === "number" ? args.count : undefined;
			if (count !== undefined) text += theme.fg("dim", ` · ${count} results`);
			if (args?.needContent) text += theme.fg("dim", " · with content");
			return new Text(text, 0, 0);
		},

		renderResult(result, { expanded, isPartial }, theme) {
			if (isPartial) return new Text(theme.fg("warning", "Searching…"), 0, 0);
			const details = result.details as SearchDetails | undefined;
			if (!details) {
				const first = result.content?.[0];
				return new Text(first?.type === "text" ? first.text : theme.fg("dim", "No output"), 0, 0);
			}
			if (details.resultCount === 0) {
				return new Text(theme.fg("dim", `No results for "${details.query}"`), 0, 0);
			}

			let text = theme.fg("success", `${details.resultCount} result${details.resultCount === 1 ? "" : "s"}`);
			text += theme.fg("muted", ` for "${details.query}"`);
			if (details.cached) text += theme.fg("dim", " · cached");

			if (expanded) {
				for (const item of details.results) {
					const meta: string[] = [];
					if (item.siteName) meta.push(oneLine(item.siteName));
					if (item.date) meta.push(oneLine(item.date).slice(0, 10));
					if (typeof item.rerankScore === "number") meta.push(`score ${item.rerankScore.toFixed(1)}`);
					text += `\n${theme.fg("accent", oneLine(item.title) || "(untitled)")}`;
					if (meta.length) text += theme.fg("dim", ` — ${meta.join(" · ")}`);
					text += `\n${theme.fg("muted", item.url)}`;
				}
				if (details.truncation?.truncated) {
					text += `\n${theme.fg("warning", "Output truncated")}${theme.fg("dim", ` · full output: ${details.fullOutputPath}`)}`;
				}
			}
			return new Text(text, 0, 0);
		},
	});

	pi.registerTool({
		name: "deepseek_fetch",
		label: "DeepSeek Fetch",
		description:
			"Fetch a single web page through DeepSeek and return its title plus content as Markdown. " +
			"Use it when a deepseek_search result needs its full text. URL must be http(s) with a host, " +
			"at most 8192 characters, and must not contain credentials.",
		parameters: Type.Object({
			url: Type.String({
				minLength: 1,
				maxLength: 8192,
				description: "Absolute http(s) URL of the page to fetch.",
			}),
		}),

		async execute(_toolCallId, params, signal, onUpdate) {
			const url = params.url.trim();
			if (!/^https?:\/\/[^\s/]+/i.test(url)) {
				throw new Error(`deepseek_fetch requires an absolute http(s) URL, got: ${url}`);
			}

			onUpdate?.({
				content: [{ type: "text", text: `Fetching ${url}…` }],
				details: { url, title: "", chars: 0 } as FetchDetails,
			});

			const response = await postJson<FetchResponse>(FETCH_PATH, { url }, signal);
			const title = oneLine(response.title);
			const content = response.content ?? "";
			const body = `${title ? `# ${title}\n\n` : ""}${content}`.trim() || `(no extractable content at ${url})`;
			const output = await finalizeOutput(body, "deepseek-fetch");

			const details: FetchDetails = {
				url,
				title,
				chars: content.length,
				truncation: output.truncation,
				fullOutputPath: output.fullOutputPath,
			};

			return { content: [{ type: "text", text: output.text }], details };
		},

		renderCall(args, theme) {
			const url = oneLine(typeof args?.url === "string" ? args.url : "");
			return new Text(theme.fg("toolTitle", theme.bold("deepseek_fetch ")) + theme.fg("accent", url), 0, 0);
		},

		renderResult(result, { expanded, isPartial }, theme) {
			if (isPartial) return new Text(theme.fg("warning", "Fetching…"), 0, 0);
			const details = result.details as FetchDetails | undefined;
			if (!details) {
				const first = result.content?.[0];
				return new Text(first?.type === "text" ? first.text : theme.fg("dim", "No output"), 0, 0);
			}

			let text = theme.fg("success", `${details.chars.toLocaleString()} chars`);
			if (details.title) text += theme.fg("muted", ` · ${details.title}`);
			if (details.truncation?.truncated) text += theme.fg("warning", " (truncated)");

			if (expanded) {
				for (const item of result.content ?? []) {
					if (item.type === "text") {
						for (const line of item.text.split("\n").slice(0, 20)) text += `\n${theme.fg("dim", line)}`;
					}
				}
				if (details.fullOutputPath) text += `\n${theme.fg("dim", `Full output: ${details.fullOutputPath}`)}`;
			}
			return new Text(text, 0, 0);
		},
	});
}
