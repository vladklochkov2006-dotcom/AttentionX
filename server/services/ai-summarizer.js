/**
 * AI Feed Summarizer using OpenRouter API
 * Generates Bloomberg/BBC-style financial news headlines from raw tweets.
 */

import { appendFileSync, mkdirSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const LOG_DIR = join(__dirname, '../logs');

if (!existsSync(LOG_DIR)) {
    mkdirSync(LOG_DIR, { recursive: true });
}

// Log context — set by setSummarizerContext() before batch runs
let _sumCtx = { scoringDate: 'unknown', runTag: '' };

export function setSummarizerContext(scoringDate) {
    const now = new Date();
    const hh = String(now.getUTCHours()).padStart(2, '0');
    const mm = String(now.getUTCMinutes()).padStart(2, '0');
    _sumCtx = {
        scoringDate,
        runTag: `${now.toISOString().split('T')[0]}_${hh}${mm}`,
    };
}

function logAISummarizer(entry) {
    const logFile = join(LOG_DIR, `ai-summarizer_${_sumCtx.scoringDate}_run${_sumCtx.runTag}.log`);
    appendFileSync(logFile, JSON.stringify({
        timestamp: new Date().toISOString(),
        scoringDate: _sumCtx.scoringDate,
        ...entry
    }) + '\n');
}

const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';

// Model fallback chain — try each in order until one succeeds
const AI_MODELS = [
    process.env.AI_SCORER_MODEL || 'google/gemma-3-4b-it:free',
    'google/gemma-3-4b-it:free',
    'stepfun/step-3.5-flash:free',
    'arcee-ai/trinity-large-preview:free',
    'z-ai/glm-4.5-air:free',
    'qwen/qwen3-vl-235b-a22b-thinking',
].filter((v, i, arr) => arr.indexOf(v) === i); // deduplicate

const SYSTEM_PROMPT = `You are a senior financial news editor at Bloomberg or BBC Business. Your job is to transform raw social media posts from tech startups into authoritative, professional news headlines.

STYLE RULES:
- Write in the style of Bloomberg Terminal headlines or BBC Business breaking news
- Use active voice and present tense ("Raises", "Launches", "Partners With")
- Lead with the company name when possible
- Include specific numbers, metrics, or named entities from the tweet when available
- Be factual and precise — never embellish or add information not in the source
- Convey significance: why does this matter?
- No hashtags, no emojis, no exclamation marks, no clickbait
- No quotation marks unless directly quoting someone
- Keep headlines between 40-90 characters

HEADLINE PATTERNS BY EVENT TYPE:
- FUNDING: "[Company] Raises $[X] in [Round Type] to [Purpose]"
- PARTNERSHIP: "[Company] Partners With [Partner] for [Goal]"
- PRODUCT_LAUNCH: "[Company] Launches [Product], Targeting [Market]"
- KEY_HIRE: "[Company] Taps [Person/Role] to Lead [Area]"
- ACQUISITION: "[Company] Acquires [Target] in [Detail]"
- REVENUE/GROWTH: "[Company] Hits [Metric], Signals [Trend]"
- MEDIA_MENTION: "[Company] Gains [Outlet] Coverage on [Topic]"
- ENGAGEMENT: "[Company] Post Draws [Scale] Engagement on [Topic]"

Always respond with a valid JSON array of strings. One headline per event, same order as input.`;

/**
 * Summarize a batch of feed events into Bloomberg/BBC-style headlines.
 * @param {Array<{id: number, startup_name: string, event_type: string, description: string, points: number}>} events
 * @returns {Array<{id: number, summary: string}>}
 */
export async function summarizeFeedEvents(events) {
    const apiKey = process.env.OPENROUTER_API_KEY;
    if (!apiKey) {
        console.warn('[AI] No OPENROUTER_API_KEY set, using fallback truncation');
        logAISummarizer({
            type: 'summarizer_skip', reason: 'no_api_key',
            eventCount: events.length,
            events: events.map(e => ({ id: e.id, startup: e.startup_name, eventType: e.event_type }))
        });
        return fallbackSummaries(events);
    }

    if (events.length === 0) return [];

    // Build batch prompt with structured context
    const eventList = events.map((e, i) =>
        `${i + 1}. Company: ${e.startup_name} | Event: ${e.event_type} | Impact: ${e.points}pts\n   Tweet: "${e.description}"`
    ).join('\n\n');

    const prompt = `Write a professional news headline for each of the following ${events.length} startup events. Return ONLY a JSON array of strings, no markdown, no explanation.

${eventList}`;

    // Try each model in fallback chain
    for (const model of AI_MODELS) {
        const startTime = Date.now();
        try {
            console.log(`[AI Summarizer] Trying model: ${model}`);
            const response = await fetch(OPENROUTER_URL, {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${apiKey}`,
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({
                    model,
                    messages: [
                        { role: 'user', content: SYSTEM_PROMPT + '\n\n---\n\n' + prompt },
                    ],
                    temperature: 0.4,
                    max_tokens: 2000,
                }),
            });

            const latencyMs = Date.now() - startTime;

            if (!response.ok) {
                const err = await response.text();
                console.error(`[AI Summarizer] ${model} error ${response.status}: ${err.substring(0, 100)}`);
                logAISummarizer({
                    type: 'summarizer_model_fail', model, reason: 'http_error',
                    status: response.status, error: err.substring(0, 200),
                    latencyMs, eventCount: events.length
                });
                continue; // try next model
            }

            const data = await response.json();
            const content = data.choices?.[0]?.message?.content?.trim();

            if (!content) {
                console.error(`[AI Summarizer] ${model} empty response`);
                logAISummarizer({
                    type: 'summarizer_model_fail', model, reason: 'empty_response',
                    latencyMs, eventCount: events.length
                });
                continue;
            }

            // Parse JSON array from response
            let headlines;
            try {
                const cleaned = content.replace(/^```json?\s*/, '').replace(/\s*```$/, '');
                headlines = JSON.parse(cleaned);
            } catch (parseErr) {
                console.error(`[AI Summarizer] ${model} failed to parse:`, content.substring(0, 200));
                logAISummarizer({
                    type: 'summarizer_model_fail', model, reason: 'json_parse_error',
                    rawResponse: content.substring(0, 300), latencyMs, eventCount: events.length
                });
                continue;
            }

            if (!Array.isArray(headlines) || headlines.length !== events.length) {
                console.warn(`[AI Summarizer] ${model} headline count mismatch (got ${headlines?.length}, expected ${events.length}), using partial`);
                logAISummarizer({
                    type: 'summarizer_model_fail', model, reason: 'count_mismatch',
                    expected: events.length, got: headlines?.length, latencyMs
                });
            }

            console.log(`[AI Summarizer] ${model} succeeded — ${events.length} headlines (${latencyMs}ms)`);

            const result = events.map((e, i) => {
                const aiHeadline = headlines[i];
                const usedFallback = !aiHeadline;
                return {
                    id: e.id,
                    summary: (aiHeadline || truncateFallback(e.description)).substring(0, 120),
                    _usedFallback: usedFallback,
                };
            });

            // Log detailed success with per-event breakdown
            logAISummarizer({
                type: 'summarizer_success', model, latencyMs,
                eventCount: events.length,
                aiHeadlines: result.filter(r => !r._usedFallback).length,
                truncationFallbacks: result.filter(r => r._usedFallback).length,
                details: result.map((r, i) => ({
                    id: r.id,
                    startup: events[i].startup_name,
                    eventType: events[i].event_type,
                    headline: r.summary,
                    method: r._usedFallback ? 'truncation' : 'AI',
                    originalPreview: (events[i].description || '').substring(0, 80)
                }))
            });

            // Strip internal flag before returning
            return result.map(({ _usedFallback, ...rest }) => rest);

        } catch (err) {
            const latencyMs = Date.now() - startTime;
            console.error(`[AI Summarizer] ${model} error: ${err.message}`);
            logAISummarizer({
                type: 'summarizer_model_fail', model, reason: 'exception',
                error: err.message, latencyMs, eventCount: events.length
            });
            continue;
        }
    }

    console.warn('[AI Summarizer] All models failed, using truncation fallback');
    logAISummarizer({
        type: 'summarizer_all_failed',
        modelsAttempted: AI_MODELS, eventCount: events.length,
        events: events.map(e => ({ id: e.id, startup: e.startup_name, eventType: e.event_type }))
    });
    return fallbackSummaries(events);
}

function truncateFallback(text) {
    if (text.length <= 90) return text;
    const cut = text.substring(0, 87);
    const lastSpace = cut.lastIndexOf(' ');
    return (lastSpace > 40 ? cut.substring(0, lastSpace) : cut) + '...';
}

function fallbackSummaries(events) {
    return events.map(e => ({
        id: e.id,
        summary: truncateFallback(e.description),
    }));
}
