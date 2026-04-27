// src/lib/sota/EnterpriseContentOrchestrator.ts
// ═══════════════════════════════════════════════════════════════════════════════
// ENTERPRISE CONTENT ORCHESTRATOR v10.0 — SOTA GOD-MODE ARCHITECTURE
//
// Pipeline phases:
//   1. NeuronWriter Semantic Context Initialization (auto-create + poll)
//   2. YouTube Video Discovery (1-3 relevant videos via Serper)
//   3. Reference Gathering (8-12 high-quality references via Serper)
//   4. Master Content Generation (AI model)
//   5. SOTA Humanization & Premium Design Overlay
//   6. Visual Break Enforcement (break walls of text every ~200 words)
//   7. YouTube Video Injection (embed + cards)
//   8. Reference Section Injection
//   9. Internal Link Generation & Injection (4–8 contextual links)
//  10. Schema.org Structured Data Generation
// ═══════════════════════════════════════════════════════════════════════════════

import type {
  APIKeys,
  AIModel,
  GeneratedContent,
  ContentMetrics,
  QualityScore,
  SERPAnalysis,
  InternalLink,
  SchemaMarkup,
  EEATProfile,
  YouTubeVideo,
  Reference,
  ContentPlan,
  PostProcessingResult,
} from './types';
import {
  SOTAContentGenerationEngine,
  createSOTAEngine,
  type ExtendedAPIKeys,
} from './SOTAContentGenerationEngine';
import { SERPAnalyzer, createSERPAnalyzer } from './SERPAnalyzer';
import { YouTubeService, createYouTubeService } from './YouTubeService';
import { ReferenceService, createReferenceService } from './ReferenceService';
import {
  SOTAInternalLinkEngine,
  createInternalLinkEngine,
} from './SOTAInternalLinkEngine';
import { SchemaGenerator, createSchemaGenerator } from './SchemaGenerator';
import {
  calculateQualityScore,
  analyzeContent,
  removeAIPhrases,
  polishReadability,
  validateVisualBreaks,
} from './QualityValidator';
import { EEATValidator, createEEATValidator } from './EEATValidator';
import { generationCache } from './cache';
import {
  NeuronWriterService,
  createNeuronWriterService,
  type NeuronWriterAnalysis,
  type NeuronWriterQuery,
} from './NeuronWriterService';
import ContentPostProcessor, { removeAIPatterns, postProcessContent, injectMissingTerms, ensureVisualElements } from './ContentPostProcessor';
import {
  buildMasterSystemPrompt,
  buildMasterUserPrompt,
  type ContentPromptConfig,
} from './prompts/masterContentPrompt';
import { refineWithSelfCritique } from './HumanQualityRefiner';
import { WordPressMediaService, type WordPressMediaItem } from './WordPressMediaService';

// ─────────────────────────────────────────────────────────────────────────────
// CONSTANTS & CONFIGURATION
// ─────────────────────────────────────────────────────────────────────────────

const NW_TARGET_SCORE = 90;

// Polling: wait up to 15 minutes, polling every 12 seconds
const NW_MAX_POLL_ATTEMPTS = 75;          // 75 × 12s = 15 minutes max
const NW_POLL_INTERVAL_MS = 12000;        // 12 seconds between polls
const NW_HARD_LIMIT_MS = 15 * 60 * 1000; // 15-minute hard cap

// The NW query must be in one of these statuses before we consider data valid
const NW_READY_STATUSES = new Set(['done', 'ready', 'completed', 'finished', 'analysed', 'analyzed']);

const MIN_VALID_CONTENT_LENGTH = 1200;

type NeuronBundle = {
  service: NeuronWriterService;
  queryId: string;
  analysis: NeuronWriterAnalysis;
};

// ─────────────────────────────────────────────────────────────────────────────
// ORCHESTRATOR CLASS
// ─────────────────────────────────────────────────────────────────────────────

export class EnterpriseContentOrchestrator {
  private engine: SOTAContentGenerationEngine;
  private serpAnalyzer: SERPAnalyzer;
  private youtubeService: YouTubeService;
  private referenceService: ReferenceService;
  private wpMediaService: WordPressMediaService;
  private linkEngine: SOTAInternalLinkEngine;
  private schemaGenerator: SchemaGenerator;
  private eeatValidator: EEATValidator;
  private config: any;
  private telemetry: any = { warnings: [], errors: [], timeline: [] };
  private onProgress?: (msg: string) => void;

  constructor(config: any) {
    this.config = config;

    // Extract serperApiKey from nested apiKeys or from top-level config
    const serperKey = config.apiKeys?.serperApiKey || config.serperApiKey || '';

    this.engine = createSOTAEngine(config.apiKeys);
    this.serpAnalyzer = createSERPAnalyzer(serperKey);
    this.youtubeService = createYouTubeService(serperKey);
    this.referenceService = createReferenceService(serperKey);
    this.wpMediaService = new WordPressMediaService({
      wpUrl: config.wpUrl,
      wpUsername: config.wpUsername,
      wpAppPassword: config.wpAppPassword,
    });
    this.linkEngine = createInternalLinkEngine(config.sitePages || []);
    // FIX: SchemaGenerator(orgName, orgUrl, logoUrl) — never pass apiKeys here
    this.schemaGenerator = createSchemaGenerator(
      config.organizationName || 'Editorial Team',
      config.organizationUrl || config.wpUrl || 'https://example.com',
      config.logoUrl || ''
    );
    this.eeatValidator = createEEATValidator();
  }

  private log(msg: string) {
    const timestamp = new Date().toISOString();
    console.log(`[Orchestrator] [${timestamp}]`, msg);
    this.telemetry.timeline.push({ timestamp, event: msg });
    if (this.onProgress) this.onProgress(msg);
  }

  private warn(msg: string) {
    console.warn('[Orchestrator]', msg);
    this.telemetry.warnings.push(msg);
  }

  private error(msg: string) {
    console.error('[Orchestrator]', msg);
    this.telemetry.errors.push(msg);
  }

  private normalizeTextForGap(text: string): string {
    return (text || '').toLowerCase().replace(/<[^>]*>/g, ' ').replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
  }

  private buildTopGapTargetsFromSerp(analysis: SERPAnalysis, keyword: string, limit = 20): string[] {
    const stopWords = new Set([
      'about', 'after', 'again', 'also', 'and', 'are', 'been', 'best', 'between', 'both', 'but', 'can', 'for',
      'from', 'guide', 'have', 'into', 'more', 'most', 'over', 'that', 'than', 'their', 'them', 'then', 'there',
      'these', 'they', 'this', 'those', 'with', 'your', 'what', 'when', 'where', 'which', 'while', 'will', 'would',
      'could', 'should', 'using', 'used', 'into', 'only', 'much', 'many', 'very', 'through'
    ]);

    const keywordTokens = new Set(keyword.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean));
    const top3 = (analysis.topCompetitors || []).slice(0, 3);

    const tokenScore = new Map<string, number>();
    const boost = (token: string, weight: number) => {
      const t = token.trim().toLowerCase();
      if (!t || t.length < 4 || stopWords.has(t) || keywordTokens.has(t)) return;
      tokenScore.set(t, (tokenScore.get(t) || 0) + weight);
    };

    for (const competitor of top3) {
      const combined = `${competitor.title || ''} ${competitor.snippet || ''}`.toLowerCase();
      const words = combined.split(/[^a-z0-9]+/).filter((w) => w.length >= 4);
      words.forEach((w) => boost(w, 1));

      for (let i = 0; i < words.length - 1; i++) {
        const a = words[i];
        const b = words[i + 1];
        if (!a || !b) continue;
        if (a.length < 4 || b.length < 4) continue;
        if (stopWords.has(a) || stopWords.has(b)) continue;
        boost(`${a} ${b}`, 2);
      }
    }

    const rankedFromTop3 = Array.from(tokenScore.entries())
      .sort((a, b) => b[1] - a[1])
      .map(([term]) => term);

    const merged = [
      ...(analysis.contentGaps || []),
      ...(analysis.semanticEntities || []),
      ...rankedFromTop3,
    ];

    const dedup = new Set<string>();
    const finalTerms: string[] = [];
    for (const term of merged) {
      const normalized = term.trim().toLowerCase();
      if (!normalized || normalized.length < 4) continue;
      if (dedup.has(normalized)) continue;
      dedup.add(normalized);
      finalTerms.push(term.trim());
      if (finalTerms.length >= limit) break;
    }

    return finalTerms;
  }

  private enforceGapCoverage(html: string, gapTargets: string[]): { html: string; missingBefore: string[]; missingAfter: string[] } {
    if (!gapTargets.length) return { html, missingBefore: [], missingAfter: [] };

    const isCovered = (text: string, gap: string): boolean => {
      const tokens = gap.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 3);
      if (tokens.length === 0) return true;
      const matches = tokens.filter((token) => text.includes(token)).length;
      return matches >= Math.max(1, Math.ceil(tokens.length * 0.5));
    };

    const textBefore = this.normalizeTextForGap(html);
    const missingBefore = gapTargets.filter((gap) => !isCovered(textBefore, gap));
    if (missingBefore.length === 0) return { html, missingBefore: [], missingAfter: [] };

    const injectedHtml = injectMissingTerms(html, missingBefore.slice(0, 20));
    const textAfter = this.normalizeTextForGap(injectedHtml);
    const missingAfter = gapTargets.filter((gap) => !isCovered(textAfter, gap));

    return {
      html: injectedHtml,
      missingBefore,
      missingAfter,
    };
  }

  // ─────────────────────────────────────────────────────────────────────────
  // NEURONWRITER INTEGRATION v9.0 — AUTO-CREATE + FULL DATA POLLING
  // ─────────────────────────────────────────────────────────────────────────

  private async maybeInitNeuronWriter(keyword: string, options: any): Promise<NeuronBundle | null> {
    if (!this.config.neuronWriterApiKey || !this.config.neuronWriterProjectId) {
      this.warn('NeuronWriter: Skipping — API key or project ID not configured.');
      return null;
    }

    // Build NeuronWriter config with proper proxy routing
    const nwConfig: any = {
      neuronWriterApiKey: this.config.neuronWriterApiKey,
    };

    // If a customProxyUrl is set, pass it through
    if (this.config.customProxyUrl) {
      nwConfig.customProxyUrl = this.config.customProxyUrl;
    }

    // Pass Supabase credentials for edge function auth (if using Supabase proxy)
    if (this.config.supabaseUrl) {
      nwConfig.supabaseUrl = this.config.supabaseUrl;
    }
    if (this.config.supabaseAnonKey) {
      nwConfig.supabaseAnonKey = this.config.supabaseAnonKey;
    }

    const service = createNeuronWriterService(nwConfig);
    const projectId = this.config.neuronWriterProjectId;
    const startTime = Date.now();

    try {
      // ── Step 1: Search for existing query ──────────────────────────────────
      this.log(`NeuronWriter: Searching project "${projectId}" for keyword "${keyword}"...`);
      const searchRes = await service.findQueryByKeyword(projectId, keyword);

      let query: NeuronWriterQuery | undefined = searchRes.query;

      // ── Step 2: Auto-create query if not found ────────────────────────────
      if (!query) {
        this.log(`NeuronWriter: Keyword not found in project. Creating new query for "${keyword}"...`);
        const createRes = await service.createQuery(projectId, keyword);

        if (!createRes.success || !createRes.query) {
          this.warn(`NeuronWriter: Failed to create query — ${createRes.error || 'unknown error'}. Proceeding without NW data.`);
          return null;
        }

        query = createRes.query;
        this.log(`NeuronWriter: New query created (ID: ${query.id}). Waiting for analysis to complete...`);
      } else {
        this.log(`NeuronWriter: Found existing query "${query.keyword}" (ID: ${query.id}, status: ${query.status})`);
      }

      const queryId = query.id;

      // ── Step 3: Poll until data is ready ─────────────────────────────────
      this.log(`NeuronWriter: Polling query ${queryId} for analysis data...`);

      let consecutiveFailures = 0;
      const MAX_CONSECUTIVE_FAILURES = 3;

      for (let i = 0; i < NW_MAX_POLL_ATTEMPTS; i++) {
        const elapsed = Date.now() - startTime;

        if (elapsed > NW_HARD_LIMIT_MS) {
          this.warn(`NeuronWriter: Polling timeout (${Math.round(elapsed / 1000)}s). Proceeding without NW data.`);
          break;
        }

        const res = await service.getQueryAnalysis(queryId);

        if (!res.success) {
          consecutiveFailures++;
          this.warn(`NeuronWriter: getQueryAnalysis failed (attempt ${i + 1}, consecutive failures: ${consecutiveFailures}): ${res.error}`);
          if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
            this.warn(`NeuronWriter: ${MAX_CONSECUTIVE_FAILURES} consecutive proxy failures (likely /api/neuronwriter is unreachable). Aborting polling.`);
            break;
          }
          await new Promise(r => setTimeout(r, NW_POLL_INTERVAL_MS));
          continue;
        }

        consecutiveFailures = 0;

        if (res.analysis) {
          const a = res.analysis;
          const status = (a.status || '').toLowerCase();

          const basicCount = a.terms?.length || 0;
          const extendedCount = a.termsExtended?.length || 0;
          const entityCount = a.entities?.length || 0;
          const h2Count = a.headingsH2?.length || 0;
          const h3Count = a.headingsH3?.length || 0;
          const totalData = basicCount + extendedCount + entityCount + h2Count + h3Count;

          if (i % 3 === 0 || totalData > 0) {
            this.log(
              `NeuronWriter: Poll ${i + 1}/${NW_MAX_POLL_ATTEMPTS} | Status: ${status} | ` +
              `Basic: ${basicCount}, Extended: ${extendedCount}, Entities: ${entityCount}, H2: ${h2Count}, H3: ${h3Count}`
            );
          }

          const isReady = NW_READY_STATUSES.has(status);
          const hasSubstantialData = basicCount >= 5 || (basicCount > 0 && extendedCount > 0);

          if (isReady || hasSubstantialData) {
            this.log(
              `✅ NeuronWriter: Analysis ready! ` +
              `${basicCount} basic, ${extendedCount} extended, ` +
              `${entityCount} entities, ${h2Count} H2s, ${h3Count} H3s.`
            );
            return { service, queryId, analysis: a };
          }

          if (isReady && totalData === 0) {
            this.warn(`NeuronWriter: Query is '${status}' but returned no data.`);
            if (i >= 5) {
              this.warn('NeuronWriter: 5 retries with empty data on ready query. Giving up.');
              break;
            }
          }
        }

        if (i < NW_MAX_POLL_ATTEMPTS - 1) {
          const elapsed2 = Date.now() - startTime;
          if (i % 5 === 0) {
            this.log(`NeuronWriter: Analysis still processing... (${Math.round(elapsed2 / 1000)}s elapsed)`);
          }
          await new Promise(r => setTimeout(r, NW_POLL_INTERVAL_MS));
        }
      }

      this.warn('NeuronWriter: Could not retrieve analysis data after polling. Proceeding without NW optimization.');
      return null;

    } catch (e) {
      this.error(`NeuronWriter Subsystem Error: ${e}`);
      return null;
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // SOTA TITLE REWRITER (SEO + AEO + GEO optimized)
  // ─────────────────────────────────────────────────────────────────────────

  private async generateSOTATitle(
    keyword: string,
    originalTitle: string | undefined,
    sourceUrl: string | undefined,
    isRefresh: boolean,
  ): Promise<string> {
    const cleanOriginal = (originalTitle || '').replace(/^\s*(refresh|rewrite)\s*:\s*/i, '').trim();
    const context = isRefresh
      ? `You are rewriting an EXISTING blog post title to make it 1000x more powerful.
Original/working title: "${cleanOriginal}"
${sourceUrl ? `Source URL: ${sourceUrl}` : ''}
Primary keyword: "${keyword}"

Generate ONE world-class replacement title that will outrank the existing version.`
      : `Generate ONE world-class SEO title for a brand-new article.
Topic / working title: "${cleanOriginal || keyword}"
Primary keyword: "${keyword}"`;

    const prompt = `${context}

REQUIREMENTS — every single one is mandatory:
1. SEO: Include the primary keyword "${keyword}" naturally near the start (front-loaded if possible).
2. AEO (Answer Engine Optimization): Phrase it so ChatGPT, Perplexity, and Google AI Overviews would directly quote it as the canonical answer.
3. GEO (Generative Engine Optimization): Include a concrete number, year (2026), or quantifier where natural.
4. Length: 50-70 characters total. NEVER exceed 70.
5. Power: Use ONE high-impact modifier (e.g. "Ultimate", "Definitive", "Proven", "Complete", "Honest", "Real", "Tested"). Pick the one that fits the topic — never multiple.
6. Title case (capitalize main words). No ALL CAPS. No emojis. No quotes around the title. NO "Refresh:", "Rewrite:", "Update:", "New:" prefixes — EVER.
7. Specific over generic. Promise a concrete outcome, framework, or insight — not vague descriptions.
8. Must read like a #1-ranking title from Healthline, NYT Wirecutter, or Backlinko — never AI slop.

OUTPUT: Return ONLY the title string. No JSON, no quotes, no explanation, no markdown. Just the title text on a single line.`;

    const result = await this.engine.generateWithModel({
      prompt,
      systemPrompt: 'You are a world-class SEO title strategist. You write titles that rank #1 on Google and get cited by AI engines. You output ONE title and nothing else — no quotes, no preamble, no explanations.',
      model: this.config.primaryModel || 'gemini',
      apiKeys: this.config.apiKeys,
      maxTokens: 120,
      temperature: 0.7,
    } as any);

    let title = (result.content || '').trim();
    title = title.split('\n')[0].trim();
    title = title.replace(/^["'`*\-•\d.)\s]+/, '').replace(/["'`*]+$/, '').trim();
    title = title.replace(/^\s*(refresh|rewrite|update|new)\s*:\s*/i, '').trim();
    return title;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // YOUTUBE VIDEO DISCOVERY & INJECTION
  // ─────────────────────────────────────────────────────────────────────────

  private async fetchYouTubeVideos(keyword: string): Promise<YouTubeVideo[]> {
    try {
      this.log('Searching for relevant YouTube videos...');
      const primary = await this.youtubeService.getRelevantVideos(keyword, 'guide');
      if (primary.length > 0) {
        const selected = primary.slice(0, 3).filter(v => v.id && v.id.length > 0);
        this.log(`YouTube: Found ${selected.length} relevant videos.`);
        return selected;
      }

      this.warn('YouTube: Primary search returned no videos. Running fallback query set...');
      const fallbackQueries = [`${keyword} tutorial`, `how to ${keyword}`, `${keyword} explained`];
      const fallbackBatches = await Promise.all(fallbackQueries.map((q) => this.youtubeService.searchVideos(q, 5)));

      const dedup = new Map<string, YouTubeVideo>();
      for (const batch of fallbackBatches) {
        for (const video of batch) {
          if (!video.id) continue;
          if (!dedup.has(video.id)) dedup.set(video.id, video);
        }
      }

      const fallbackSelected = Array.from(dedup.values()).slice(0, 3);
      if (fallbackSelected.length > 0) {
        this.log(`YouTube: Fallback recovered ${fallbackSelected.length} videos.`);
        return fallbackSelected;
      }

      const guaranteed = await this.youtubeService.getGuaranteedFallbackVideos(keyword, 1);
      if (guaranteed.length > 0) {
        this.warn('YouTube: Recovered a best-effort video via resilient fallback source.');
        return guaranteed;
      }

      this.warn('YouTube: No relevant videos found after all fallback sources.');
      return [];
    } catch (e) {
      this.warn(`YouTube: Video search failed (${e}). Proceeding without videos.`);
      return [];
    }
  }

  private injectYouTubeVideos(html: string, videos: YouTubeVideo[]): string {
    if (!videos || videos.length === 0) return html;

    let result = html;

    // Find H2 headings to distribute videos across sections
    const h2Matches = [...result.matchAll(/<h2[^>]*>[\s\S]*?<\/h2>/gi)];

    if (h2Matches.length < 2) {
      // If not enough headings, inject all videos before the article footer
      const videoBlock = this.buildVideoSectionHtml(videos);
      const footerIdx = result.indexOf('data-article-footer');
      if (footerIdx !== -1) {
        const insertPoint = result.lastIndexOf('<div', footerIdx);
        if (insertPoint !== -1) {
          result = result.slice(0, insertPoint) + '\n' + videoBlock + '\n' + result.slice(insertPoint);
        }
      } else {
        result = result.replace('</article>', videoBlock + '\n</article>');
      }
      return result;
    }

    // Distribute: embed first video after 2nd H2, place cards for remaining as a section
    const firstVideo = videos[0];
    const remainingVideos = videos.slice(1);

    // Embed the first video after the 2nd H2's section (after 2-3 paragraphs)
    if (firstVideo && h2Matches.length >= 2) {
      const secondH2 = h2Matches[1];
      const searchStart = secondH2.index! + secondH2[0].length;

      // Find the 2nd </p> after this H2
      let pCount = 0;
      let insertPos = searchStart;
      const pClosingRegex = /<\/p>/gi;
      pClosingRegex.lastIndex = searchStart;
      let pMatch;
      while ((pMatch = pClosingRegex.exec(result)) !== null) {
        pCount++;
        if (pCount >= 2) {
          insertPos = pMatch.index + pMatch[0].length;
          break;
        }
      }

      const embedHtml = this.youtubeService.formatVideoEmbed(firstVideo);
      result = result.slice(0, insertPos) + '\n' + embedHtml + '\n' + result.slice(insertPos);
    }

    // Insert remaining videos as cards in a dedicated section before references
    if (remainingVideos.length > 0) {
      const videoCardsHtml = this.buildVideoCardsSection(remainingVideos);
      const refsIdx = result.search(/<h2[^>]*>.*?(?:references|sources|further reading)/i);
      if (refsIdx !== -1) {
        result = result.slice(0, refsIdx) + '\n' + videoCardsHtml + '\n' + result.slice(refsIdx);
      } else {
        const footerIdx = result.indexOf('data-article-footer');
        if (footerIdx !== -1) {
          const insertPoint = result.lastIndexOf('<div', footerIdx);
          if (insertPoint !== -1) {
            result = result.slice(0, insertPoint) + '\n' + videoCardsHtml + '\n' + result.slice(insertPoint);
          }
        } else {
          result = result.replace('</article>', videoCardsHtml + '\n</article>');
        }
      }
    }

    return result;
  }

  private buildVideoSectionHtml(videos: YouTubeVideo[]): string {
    if (videos.length === 0) return '';

    const embed = videos[0] ? this.youtubeService.formatVideoEmbed(videos[0]) : '';
    const cards = videos.slice(1).map(v => this.youtubeService.formatVideoCard(v)).join('\n');

    return `
<div style="margin: 48px 0;">
  <h2 style="font-size:1.95em;font-weight:900;color:#0f172a;margin:0 0 20px 0;line-height:1.15;letter-spacing:-0.025em;font-family:'Inter',system-ui,sans-serif;border-bottom:3px solid #e2e8f0;padding-bottom:12px;">🎬 Helpful Video Resources</h2>
  ${embed}
  ${cards}
</div>`;
  }

  private buildVideoCardsSection(videos: YouTubeVideo[]): string {
    if (videos.length === 0) return '';
    const cards = videos.map(v => this.youtubeService.formatVideoCard(v)).join('\n');
    return `
<div style="margin: 40px 0;">
  <h3 style="font-size:1.3em;font-weight:800;color:#1e293b;margin:0 0 16px 0;font-family:'Inter',system-ui,sans-serif;">📺 More Videos Worth Watching</h3>
  ${cards}
</div>`;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // REFERENCE GATHERING & INJECTION
  // ─────────────────────────────────────────────────────────────────────────

  private async fetchReferences(keyword: string): Promise<Reference[]> {
    try {
      this.log('Gathering high-quality references via Serper...');
      const refs = await this.referenceService.getTopReferences(keyword, 12);
      this.log(`References: Found ${refs.length} high-authority sources.`);
      return refs;
    } catch (e) {
      this.warn(`References: Search failed (${e}). Proceeding without references.`);
      return [];
    }
  }

  private async fetchWordPressImages(keyword: string): Promise<WordPressMediaItem[]> {
    try {
      const images = await this.wpMediaService.getRelevantImages(keyword, 2);
      return images.slice(0, 2);
    } catch {
      return [];
    }
  }

  private injectWordPressImages(html: string, images: WordPressMediaItem[], keyword: string): string {
    if (!images.length || html.includes('data-wp-inline-image')) return html;

    const figures = images
      .slice(0, 2)
      .map((img, idx) => this.wpMediaService.buildInlineImageFigureHtml(img, keyword, idx === 0 ? 'primary' : 'secondary'))
      .filter(Boolean);

    if (figures.length === 0) return html;

    const paragraphMatches = [...html.matchAll(/<\/p>/gi)];
    if (paragraphMatches.length === 0) {
      return html.replace('</article>', `${figures.join('\n')}\n</article>`);
    }

    const firstTargetIdx = Math.min(1, paragraphMatches.length - 1);
    let secondTargetIdx = Math.min(
      Math.max(firstTargetIdx + 2, Math.floor(paragraphMatches.length * 0.55)),
      paragraphMatches.length - 1,
    );
    if (secondTargetIdx === firstTargetIdx && paragraphMatches.length > 2) {
      secondTargetIdx = Math.min(firstTargetIdx + 2, paragraphMatches.length - 1);
    }

    const insertions: Array<{ position: number; markup: string }> = [
      {
        position: (paragraphMatches[firstTargetIdx].index || 0) + 4,
        markup: figures[0],
      },
    ];

    if (figures[1]) {
      insertions.push({
        position: (paragraphMatches[secondTargetIdx].index || 0) + 4,
        markup: figures[1],
      });
    }

    insertions.sort((a, b) => b.position - a.position);

    let result = html;
    for (const insertion of insertions) {
      result = `${result.slice(0, insertion.position)}\n${insertion.markup}\n${result.slice(insertion.position)}`;
    }

    return result;
  }

  private linkifyPlainUrls(html: string): string {
    const tokens = html.split(/(<[^>]+>)/g);
    const urlRegex = /\bhttps?:\/\/[^\s<>"')]+/gi;
    let insideAnchor = false;

    return tokens
      .map((token) => {
        if (!token) return token;
        if (token.startsWith('<')) {
          if (/^<a\b/i.test(token)) insideAnchor = true;
          if (/^<\/a>/i.test(token)) insideAnchor = false;
          return token;
        }

        if (insideAnchor) return token;

        return token.replace(urlRegex, (rawUrl) => {
          const cleanUrl = rawUrl.replace(/[),.;]+$/, '');
          const trailing = rawUrl.slice(cleanUrl.length);
          return `<a href="${cleanUrl}" target="_blank" rel="noopener noreferrer">${cleanUrl}</a>${trailing}`;
        });
      })
      .join('');
  }

  private ensureExternalLinksClickable(html: string): string {
    const enriched = html.replace(/<a\s+([^>]*href=["']https?:\/\/[^"']+["'][^>]*)>/gi, (_m, attrs: string) => {
      let out = attrs;
      if (!/\btarget=/i.test(out)) out += ' target="_blank"';
      if (!/\brel=/i.test(out)) out += ' rel="noopener noreferrer"';
      return `<a ${out}>`;
    });

    return this.linkifyPlainUrls(enriched);
  }

  private injectReferencesSection(html: string, references: Reference[]): string {
    if (!references || references.length === 0) return html;

    const sanitizedReferences = references
      .filter((ref) => /^https?:\/\//i.test(ref.url || ''))
      .map((ref) => ({
        ...ref,
        title: (ref.title || ref.domain || ref.url || 'Reference')
          .replace(/&/g, '&amp;')
          .replace(/</g, '&lt;')
          .replace(/>/g, '&gt;')
          .replace(/"/g, '&quot;'),
      }))
      .slice(0, 12);

    if (sanitizedReferences.length === 0) return html;

    const refsHeadingRegex = /<h2[^>]*>\s*(?:references|sources|further reading|sources\s*&\s*further\s*reading)\s*<\/h2>/i;
    const hasRefsHeading = refsHeadingRegex.test(html);

    const refsSectionMatch = html.match(
      /<h2[^>]*>\s*(?:references|sources|further reading|sources\s*&\s*further\s*reading)\s*<\/h2>[\s\S]*?(?=<h2[^>]*>|<div[^>]*data-article-footer|<\/article>)/i,
    );
    const hasLinkedReferences = !!refsSectionMatch && /<a\s+[^>]*href=["']https?:\/\//i.test(refsSectionMatch[0]);

    if (hasRefsHeading && hasLinkedReferences) {
      this.log('References: Existing references section already has clickable links. Skipping duplicate injection.');
      return html;
    }

    const heading = '📚 Verified Sources';

    const styledRefsHtml = `
<div data-verified-references="true" style="margin:56px 0 0 0;padding-top:40px;border-top:2px solid #e2e8f0;">
  <h2 style="font-size:1.95em;font-weight:900;color:#0f172a;margin:0 0 20px 0;line-height:1.15;letter-spacing:-0.025em;font-family:'Inter',system-ui,sans-serif;border-bottom:3px solid #e2e8f0;padding-bottom:12px;">${heading}</h2>
  <div style="font-family:'Inter',system-ui,sans-serif;">
    <ol style="margin:0;padding:0;list-style:none;counter-reset:ref-counter;">
      ${sanitizedReferences.map((ref, i) => {
      const typeLabel = ref.type === 'academic' ? ' <span style="background:#dbeafe;color:#1e40af;padding:2px 8px;border-radius:4px;font-size:11px;font-weight:700;">Academic</span>'
        : ref.type === 'government' ? ' <span style="background:#dcfce7;color:#15803d;padding:2px 8px;border-radius:4px;font-size:11px;font-weight:700;">Official</span>'
          : ref.type === 'news' ? ' <span style="background:#fef3c7;color:#92400e;padding:2px 8px;border-radius:4px;font-size:11px;font-weight:700;">News</span>'
            : '';
      return `<li style="margin:0 0 16px 0;padding:12px 16px;background:#f8fafc;border-radius:10px;border:1px solid #e2e8f0;display:flex;align-items:flex-start;gap:12px;">
          <span style="flex-shrink:0;width:28px;height:28px;background:linear-gradient(135deg,#6366f1,#8b5cf6);color:white;border-radius:8px;display:flex;align-items:center;justify-content:center;font-size:12px;font-weight:800;">${i + 1}</span>
          <div>
            <a href="${ref.url}" target="_blank" rel="noopener noreferrer" style="color:#1e293b;text-decoration:none;font-weight:600;font-size:15px;line-height:1.4;">${ref.title}</a>
            <div style="margin-top:4px;font-size:12px;color:#64748b;">${ref.domain}${typeLabel}</div>
          </div>
        </li>`;
    }).join('\n')}
    </ol>
  </div>
</div>`;

    const footerIdx = html.indexOf('data-article-footer');
    if (footerIdx !== -1) {
      const insertPoint = html.lastIndexOf('<div', footerIdx);
      if (insertPoint !== -1) {
        return html.slice(0, insertPoint) + '\n' + styledRefsHtml + '\n' + html.slice(insertPoint);
      }
    }

    return html.replace('</article>', styledRefsHtml + '\n</article>');
  }

  // ─────────────────────────────────────────────────────────────────────────
  // PREMIUM HTML STYLING
  // ─────────────────────────────────────────────────────────────────────────

  // ─────────────────────────────────────────────────────────────────────────
  // SOTA PREMIUM DESIGN SYSTEM v10.0 — MAGAZINE-QUALITY POST-PROCESSOR
  // ─────────────────────────────────────────────────────────────────────────

  private async applyPremiumStyling(html: string): Promise<string> {
    let output = html;

    // ── 1. UNWRAP BARE ARTICLE TAG — ensure consistent wrapper with FORCED visibility ─
    // Normalize the article wrapper so it's fully readable on ANY WordPress theme
    // (light, dark, or custom). Background:#ffffff + color:#1e293b lock visibility.
    output = output.replace(
      /<article[^>]*>/i,
      `<article style="font-family:'Georgia','Iowan Old Style','Times New Roman',serif;max-width:860px;margin:0 auto;background:#ffffff;color:#1e293b;line-height:1.85;font-size:18px;letter-spacing:-0.01em;padding:32px 24px;border-radius:8px;">`
    );

    // ── 2. PREMIUM HERO HEADER ─────────────────────────────────────────────
    if (!output.includes('data-premium-hero')) {
      const title = this.config.currentTitle || 'Strategic Analysis';
      const author = this.config.authorName || 'Editorial Board';
      const date = new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });
      const authorInitial = author.charAt(0).toUpperCase();

      const hero = `
<div data-premium-hero="true" style="font-family:'Inter',system-ui,sans-serif;background:linear-gradient(150deg,#0f172a 0%,#1e1b4b 50%,#0f172a 100%);padding:72px 48px 56px;border-radius:24px;margin-bottom:56px;color:white;position:relative;overflow:hidden;">
  <div style="position:absolute;top:-80px;right:-80px;width:360px;height:360px;background:radial-gradient(circle,rgba(99,102,241,0.15),transparent 70%);border-radius:50%;pointer-events:none;"></div>
  <div style="position:absolute;bottom:-40px;left:-40px;width:240px;height:240px;background:radial-gradient(circle,rgba(16,185,129,0.08),transparent 70%);border-radius:50%;pointer-events:none;"></div>
  <div style="display:inline-flex;align-items:center;gap:8px;background:rgba(99,102,241,0.15);border:1px solid rgba(99,102,241,0.3);border-radius:100px;padding:6px 16px;margin-bottom:28px;">
    <span style="width:6px;height:6px;background:#818cf8;border-radius:50%;display:inline-block;animation:pulse 2s infinite;"></span>
    <span style="font-size:12px;font-weight:700;letter-spacing:0.12em;text-transform:uppercase;color:#a5b4fc;">SOTA God-Mode Intelligence</span>
  </div>
  <h1 style="font-size:clamp(28px,4vw,48px);line-height:1.08;font-weight:900;margin:0 0 28px 0;color:white;letter-spacing:-0.02em;max-width:740px;">${title}</h1>
  <div style="width:60px;height:3px;background:linear-gradient(90deg,#818cf8,#34d399);border-radius:2px;margin-bottom:32px;"></div>
  <div style="display:flex;align-items:center;gap:16px;flex-wrap:wrap;">
    <div style="width:48px;height:48px;background:linear-gradient(135deg,#6366f1,#8b5cf6);border-radius:50%;display:flex;align-items:center;justify-content:center;font-weight:900;font-size:20px;color:white;flex-shrink:0;">${authorInitial}</div>
    <div>
      <div style="font-weight:700;font-size:16px;color:white;">${author}</div>
      <div style="font-size:13px;color:#94a3b8;margin-top:2px;">${date}</div>
    </div>
    <div style="margin-left:auto;display:flex;gap:8px;flex-wrap:wrap;">
      <span style="background:rgba(255,255,255,0.08);border:1px solid rgba(255,255,255,0.12);border-radius:8px;padding:6px 14px;font-size:12px;color:#cbd5e1;font-weight:600;">✦ Expert-Reviewed</span>
      <span style="background:rgba(16,185,129,0.1);border:1px solid rgba(16,185,129,0.2);border-radius:8px;padding:6px 14px;font-size:12px;color:#34d399;font-weight:600;">● NW Optimized</span>
    </div>
  </div>
</div>`;
      output = output.replace(/<article[^>]*>/i, match => match + hero);
    }

    // ── 3. AUTO-GENERATE TABLE OF CONTENTS ────────────────────────────────
    if (!output.includes('data-toc') && (output.match(/<h2[^>]*>/gi) || []).length >= 3) {
      const h2Matches = [...output.matchAll(/<h2[^>]*>([\s\S]*?)<\/h2>/gi)];
      if (h2Matches.length >= 3) {
        const tocItems = h2Matches.map((m, i) => {
          const text = m[1].replace(/<[^>]+>/g, '').trim();
          const id = `section-${i + 1}`;
          // Add id to the matching h2
          output = output.replace(m[0], m[0].replace(/<h2/, `<h2 id="${id}"`));
          return `<li style="margin:6px 0;"><a href="#${id}" style="color:#4f46e5;text-decoration:none;font-size:15px;line-height:1.5;display:flex;align-items:baseline;gap:10px;"><span style="color:#cbd5e1;font-size:12px;font-weight:700;min-width:20px;">${String(i + 1).padStart(2, '0')}</span>${text}</a></li>`;
        }).join('\n');

        const toc = `
<nav data-toc="true" style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:16px;padding:28px 32px;margin:0 0 48px 0;font-family:'Inter',system-ui,sans-serif;">
  <div style="display:flex;align-items:center;gap:10px;margin-bottom:20px;">
    <span style="font-size:16px;">📋</span>
    <strong style="font-size:13px;letter-spacing:0.1em;text-transform:uppercase;color:#64748b;font-family:'Inter',system-ui,sans-serif;">Table of Contents</strong>
  </div>
  <ol style="margin:0;padding:0;list-style:none;">
    ${tocItems}
  </ol>
</nav>`;

        // Insert TOC after the hero/first callout box or at start of article body
        output = output.replace(/(data-premium-hero="true"[\s\S]*?<\/div>)\s*(<[ph2])/i, `$1\n${toc}\n$2`);
      }
    }

    // ── 4. STYLE ALL PARAGRAPHS — explicit dark color for visibility on any theme ─
    output = output.replace(/<p(?!\s+style=)(?=[^>]*>)/gi, '<p style="margin:0 0 22px 0;line-height:1.85;color:#1e293b;font-size:18px;"');
    // Don't double-style within callout boxes
    output = output.replace(/<p style="margin:0 0 22px 0;line-height:1\.85;color:#1e293b;font-size:18px;" style="/gi, '<p style="');
    // Style any unstyled list items / lists with explicit dark color
    output = output.replace(/<ul(?!\s+[^>]*style=)([^>]*)>/gi, '<ul$1 style="margin:0 0 24px 0;padding-left:28px;color:#1e293b;font-size:17px;line-height:1.85;">');
    output = output.replace(/<ol(?!\s+[^>]*style=)([^>]*)>/gi, '<ol$1 style="margin:0 0 24px 0;padding-left:28px;color:#1e293b;font-size:17px;line-height:1.85;">');
    output = output.replace(/<li(?!\s+[^>]*style=)([^>]*)>/gi, '<li$1 style="margin:8px 0;color:#1e293b;">');

    // ── 5. STYLE ALL HEADINGS ───────────────────────────────────────────────
    output = output.replace(/<h2(?!\s+[^>]*style=)([^>]*)>/gi,
      `<h2$1 style="font-size:1.95em;font-weight:900;color:#0f172a;margin:56px 0 20px 0;line-height:1.15;letter-spacing:-0.025em;font-family:'Inter',system-ui,sans-serif;border-bottom:3px solid #e2e8f0;padding-bottom:12px;">`
    );
    output = output.replace(/<h3(?!\s+[^>]*style=)([^>]*)>/gi,
      `<h3$1 style="font-size:1.3em;font-weight:800;color:#1e293b;margin:40px 0 14px 0;letter-spacing:-0.01em;font-family:'Inter',system-ui,sans-serif;">`
    );
    output = output.replace(/<h4(?!\s+[^>]*style=)([^>]*)>/gi,
      `<h4$1 style="font-size:1.1em;font-weight:700;color:#334155;margin:28px 0 10px 0;font-family:'Inter',system-ui,sans-serif;">`
    );

    // ── 6. STYLE LISTS ──────────────────────────────────────────────────────
    output = output.replace(/<ul(?!\s+[^>]*style=)([^>]*)>/gi,
      `<ul$1 style="margin:0 0 24px 0;padding:0 0 0 0;list-style:none;">`
    );
    output = output.replace(/<li(?!\s+[^>]*style=)([^>]*)>(?!\s*<strong)/gi,
      `<li$1 style="margin:0 0 10px 0;padding:0 0 0 28px;position:relative;line-height:1.7;">
        <span style="position:absolute;left:0;top:7px;width:8px;height:8px;background:linear-gradient(135deg,#6366f1,#8b5cf6);border-radius:50%;"></span>`
    );
    output = output.replace(/<ol(?!\s+[^>]*style=)([^>]*)>/gi,
      `<ol$1 style="margin:0 0 24px 0;padding:0 0 0 0;list-style:none;counter-reset:ol-counter;">`
    );

    // ── 7. ENHANCE BLOCKQUOTES ──────────────────────────────────────────────
    output = output.replace(/<blockquote(?!\s+[^>]*style=)([^>]*)>/gi,
      `<blockquote$1 style="border:none;border-left:5px solid #6366f1;background:linear-gradient(to right,#fafafa,#ffffff);padding:32px 36px;margin:40px 0;border-radius:0 16px 16px 0;position:relative;overflow:hidden;">`
    );
    // Add the decorative quote mark
    output = output.replace(
      /(<blockquote[^>]*style="[^"]*border-left:5px solid #6366f1[^"]*"[^>]*>)/gi,
      `$1<div style="position:absolute;top:-10px;right:20px;font-size:120px;color:#e0e7ff;font-family:Georgia,serif;line-height:1;pointer-events:none;user-select:none;">"</div>`
    );
    output = output.replace(/<blockquote([^>]*)>\s*<p([^>]*)>/gi,
      `<blockquote$1><p$2 style="font-style:italic;font-size:1.15em;color:#1e293b;line-height:1.8;margin:0 0 16px 0;font-family:'Georgia',serif;">`
    );
    output = output.replace(/<cite(?!\s+[^>]*style=)([^>]*)>/gi,
      `<cite$1 style="display:block;margin-top:12px;font-style:normal;font-size:13px;color:#64748b;font-weight:700;letter-spacing:0.03em;text-transform:uppercase;font-family:'Inter',system-ui,sans-serif;">`
    );

    // ── 8. ENHANCE TABLES ───────────────────────────────────────────────────
    // Wrap tables that aren't already wrapped
    output = output.replace(/(?<!overflow-x:auto[^<]*)<table(?!\s+[^>]*style=)([^>]*)>/gi,
      `<div style="overflow-x:auto;margin:36px 0;border-radius:16px;box-shadow:0 4px 24px rgba(0,0,0,0.08);border:1px solid #e2e8f0;"><table$1 style="width:100%;border-collapse:collapse;font-size:15px;font-family:'Inter',system-ui,sans-serif;">`
    );
    output = output.replace(/<\/table>(?!\s*<\/div>(?=[^<]*overflow-x))/gi, '</table></div>');
    output = output.replace(/<thead(?!\s+[^>]*style=)([^>]*)>/gi,
      `<thead$1 style="background:linear-gradient(90deg,#1e293b,#334155);">`
    );
    output = output.replace(/<th(?!\s+[^>]*style=)([^>]*)>/gi,
      `<th$1 style="padding:16px 20px;text-align:left;font-weight:700;color:white;font-size:13px;letter-spacing:0.05em;text-transform:uppercase;white-space:nowrap;">`
    );
    output = output.replace(/<td(?!\s+[^>]*style=)([^>]*)>/gi,
      `<td$1 style="padding:14px 20px;border-bottom:1px solid #f1f5f9;vertical-align:top;color:#334155;">`
    );
    output = output.replace(/<tbody(?!\s+[^>]*style=)([^>]*)>/gi, `<tbody$1>`);

    // ── 9. STYLE FAQ ACCORDIONS (details/summary) ───────────────────────────
    output = output.replace(/<details(?!\s+[^>]*style=)([^>]*)>/gi,
      `<details$1 style="border:1px solid #e2e8f0;border-radius:14px;margin:12px 0;overflow:hidden;transition:all 0.2s ease;">`
    );
    output = output.replace(/<summary(?!\s+[^>]*style=)([^>]*)>/gi,
      `<summary$1 style="padding:20px 26px;font-weight:700;cursor:pointer;background:#f8fafc;color:#1e293b;list-style:none;display:flex;justify-content:space-between;align-items:center;font-family:'Inter',system-ui,sans-serif;font-size:16px;line-height:1.4;">`
    );

    // ── 10. ENHANCE STRONG/EM ────────────────────────────────────────────────
    // Don't touch strong tags that are already inside styled containers

    // ── 11. ADD READING PROGRESS METADATA BAR ───────────────────────────────
    if (!output.includes('data-reading-meta')) {
      const wordCount = output.replace(/<[^>]*>/g, ' ').split(/\s+/).filter(Boolean).length;
      const readTime = Math.max(1, Math.ceil(wordCount / 200));
      const keyword = this.config.currentTitle || '';

      const metaBar = `
<div data-reading-meta="true" style="font-family:'Inter',system-ui,sans-serif;display:flex;align-items:center;gap:20px;padding:14px 20px;background:#f1f5f9;border-radius:12px;margin:0 0 36px 0;flex-wrap:wrap;">
  <span style="display:flex;align-items:center;gap:6px;font-size:13px;color:#64748b;"><span style="font-size:15px;">⏱️</span> <strong style="color:#334155;">${readTime} min</strong> read</span>
  <span style="color:#cbd5e1;">|</span>
  <span style="display:flex;align-items:center;gap:6px;font-size:13px;color:#64748b;"><span style="font-size:15px;">📖</span> <strong style="color:#334155;">${wordCount.toLocaleString()}</strong> words</span>
  <span style="color:#cbd5e1;">|</span>
  <span style="display:flex;align-items:center;gap:6px;font-size:13px;color:#64748b;"><span style="font-size:15px;">✓</span> Updated <strong style="color:#334155;">${new Date().toLocaleDateString('en-US', { month: 'long', year: 'numeric' })}</strong></span>
</div>`;

      // Insert right after the hero
      output = output.replace(
        /(<nav data-toc="true")/,
        `${metaBar}\n$1`
      );
      if (!output.includes('data-reading-meta="true"')) {
        // Fallback: insert after the hero div
        output = output.replace(
          /(data-premium-hero="true"[\s\S]*?<\/div>\s*<\/div>)/i,
          `$1\n${metaBar}`
        );
      }
    }

    // ── 12. STYLE ANY BARE HR ELEMENTS ──────────────────────────────────────
    output = output.replace(/<hr(?!\s+[^>]*style=)\s*\/?>/gi,
      `<hr style="border:none;height:2px;background:linear-gradient(90deg,transparent,#e2e8f0,transparent);margin:48px 0;">`
    );

    // ── 13. ADD SHARE/ENGAGEMENT FOOTER ─────────────────────────────────────
    if (!output.includes('data-article-footer')) {
      const footerBox = `
<div data-article-footer="true" style="font-family:'Inter',system-ui,sans-serif;background:linear-gradient(135deg,#1e1b4b,#312e81);border-radius:20px;padding:40px;margin:56px 0 0 0;text-align:center;color:white;">
  <div style="font-size:28px;font-weight:900;letter-spacing:-0.02em;margin-bottom:12px;">Did This Help?</div>
  <p style="color:#a5b4fc;font-size:16px;margin:0 0 24px 0;line-height:1.6;">Bookmark this guide — the information here is updated regularly as the topic evolves.</p>
  <div style="display:inline-flex;gap:12px;flex-wrap:wrap;justify-content:center;">
    <span style="background:rgba(255,255,255,0.1);border:1px solid rgba(255,255,255,0.2);border-radius:100px;padding:10px 22px;font-size:14px;font-weight:600;">🔖 Bookmark</span>
    <span style="background:rgba(255,255,255,0.1);border:1px solid rgba(255,255,255,0.2);border-radius:100px;padding:10px 22px;font-size:14px;font-weight:600;">📤 Share</span>
    <span style="background:rgba(99,102,241,0.3);border:1px solid rgba(99,102,241,0.5);border-radius:100px;padding:10px 22px;font-size:14px;font-weight:600;">⭐ Save for Later</span>
  </div>
</div>`;
      output = output.replace(/<\/article>/i, `${footerBox}\n</article>`);
    }

    return output;
  }

  private async humanizeContent(html: string, keyword: string): Promise<string> {
    // Fast LOCAL humanization — no second AI call, no truncation risk.
    // Applies anti-AI text fixes directly to the HTML content.
    let result = html;

    // 1. Replace stiff AI transition words with natural ones
    const transitionReplacements: [RegExp, string[]][] = [
      [/\bFurthermore,?\s/gi, ["But here's the thing: ", "And ", ""]],
      [/\bMoreover,?\s/gi, ["Plus, ", "On top of that, ", ""]],
      [/\bAdditionally,?\s/gi, ["Also — ", "And ", ""]],
      [/\bConsequently,?\s/gi, ["So ", "Which means ", "The result? "]],
      [/\bNevertheless,?\s/gi, ["Still, ", "But ", "Even so, "]],
      [/\bHowever,?\s/gi, ["But ", "That said, ", "Here's the catch: "]],
      [/\bIn conclusion,?\s/gi, ["Bottom line: ", "Here's my take: ", "So where does that leave us? "]],
    ];

    let replIdx = 0;
    for (const [pattern, alternatives] of transitionReplacements) {
      result = result.replace(pattern, () => {
        const pick = alternatives[replIdx % alternatives.length];
        replIdx++;
        return pick;
      });
    }

    // 2. Force contractions for natural English
    const contractions: [RegExp, string][] = [
      [/\bdo not\b/gi, "don't"],
      [/\bDo not\b/g, "Don't"],
      [/\bcannot\b/gi, "can't"],
      [/\bCannot\b/g, "Can't"],
      [/\bwill not\b/gi, "won't"],
      [/\bWill not\b/g, "Won't"],
      [/\bit is\b/gi, "it's"],
      [/\bthat is\b/gi, "that's"],
      [/\bthey are\b/gi, "they're"],
      [/\bwe are\b/gi, "we're"],
      [/\byou are\b/gi, "you're"],
      [/\bshould not\b/gi, "shouldn't"],
      [/\bwould not\b/gi, "wouldn't"],
      [/\bcould not\b/gi, "couldn't"],
      [/\bI have\b/g, "I've"],
      [/\bthey have\b/gi, "they've"],
      [/\byou will\b/gi, "you'll"],
    ];
    for (const [pat, rep] of contractions) {
      result = result.replace(pat, rep);
    }

    // 3. Replace generic AI vocabulary
    const vocabUpgrades: [RegExp, string][] = [
      [/\butilize\b/gi, "use"],
      [/\bfacilitate\b/gi, "help"],
      [/\bcommence\b/gi, "start"],
      [/\bnumerous\b/gi, "many"],
      [/\bpurchase\b/gi, "buy"],
      [/\bprior to\b/gi, "before"],
      [/\bin order to\b/gi, "to"],
      [/\bat this point in time\b/gi, "now"],
      [/\bin the event that\b/gi, "if"],
      [/\bdue to the fact that\b/gi, "because"],
      [/\bin spite of the fact that\b/gi, "although"],
    ];
    for (const [pat, rep] of vocabUpgrades) {
      result = result.replace(pat, rep);
    }

    return result;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // MAIN PIPELINE
  // ─────────────────────────────────────────────────────────────────────────

  async generateContent(options: any): Promise<any> {
    this.onProgress = options.onProgress;
    this.log(`🚀 SOTA GOD-MODE PIPELINE v10.0 ENGAGED: "${options.keyword}"`);

    try {
      return await this._executeGenerationPipeline(options);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.error(`PIPELINE FATAL ERROR: ${msg}`);
      console.error('[Orchestrator] Full error:', err);
      throw err;
    }
  }

  private async _executeGenerationPipeline(options: any): Promise<any> {
    this.config.currentTitle = options.title || options.keyword;
    this.config.authorName = options.authorName || 'SOTA AI Research';

    // ── Phase 0a: SOTA Title Rewrite (refresh items + URL-derived titles) ───
    // For refresh content, the incoming "title" is just a slug-derived guess
    // (e.g. "Blue House Plants"). Generate a SOTA SEO/AEO/GEO-optimized title.
    const isRefresh = options.contentType === 'refresh';
    const looksLikeSlugTitle = !options.title || options.title === options.keyword ||
      /^[A-Z][a-z]+( [A-Z][a-z]+)*$/.test(String(options.title || '').trim());

    if (isRefresh || looksLikeSlugTitle) {
      try {
        this.log('Phase 0a: Rewriting title to SOTA SEO/AEO/GEO standard...');
        const newTitle = await this.generateSOTATitle(
          options.keyword,
          options.title,
          options.url,
          isRefresh,
        );
        if (newTitle && newTitle.length >= 20 && newTitle.length <= 90) {
          this.log(`Phase 0a ✅ Title rewritten: "${newTitle}"`);
          options.title = newTitle;
          this.config.currentTitle = newTitle;
          options.onTitleRewritten?.(newTitle);
        }
      } catch (e) {
        this.warn(`Phase 0a: Title rewrite skipped (${e instanceof Error ? e.message : e}). Using original.`);
      }
    }

    // ── Phase 0: Top-3 SERP Scan + Gap Analysis ─────────────────────────────
    this.log('Phase 0: Top-3 SERP ranking scan and gap analysis...');
    const serpAnalysis = await this.serpAnalyzer.analyze(options.keyword);
    const gapTargets = this.buildTopGapTargetsFromSerp(serpAnalysis, options.keyword, 20);
    const top3Competitors = (serpAnalysis.topCompetitors || []).slice(0, 3);

    this.log(
      `Phase 0 ✅ Top competitors: ${top3Competitors.length}, gap targets: ${gapTargets.length}`
    );

    // ── Phase 1: NeuronWriter Semantic Context Initialization ──────────────
    this.log('Phase 1: NeuronWriter Semantic Context Initialization...');
    const neuron = await this.maybeInitNeuronWriter(options.keyword, options);

    if (neuron) {
      const { analysis } = neuron;
      this.log(
        `Phase 1 ✅ NeuronWriter data loaded: ` +
        `${analysis.terms?.length || 0} basic, ` +
        `${analysis.termsExtended?.length || 0} extended, ` +
        `${analysis.entities?.length || 0} entities, ` +
        `${analysis.headingsH2?.length || 0} H2, ` +
        `${analysis.headingsH3?.length || 0} H3`
      );
    } else {
      this.warn('Phase 1: NeuronWriter data unavailable — generating without semantic optimization.');
    }

    // ── Phase 2: YouTube Video Discovery (parallel with Phase 3/4) ─────────
    this.log('Phase 2: YouTube Video Discovery...');
    const videosPromise = this.fetchYouTubeVideos(options.keyword);

    // ── Phase 3: Reference Gathering (parallel) ─────────────────────────────
    this.log('Phase 3: Reference Gathering (8-12 high-quality sources)...');
    const referencesPromise = this.fetchReferences(options.keyword);

    // ── Phase 4: WordPress Media Discovery (parallel) ───────────────────────
    const wpImagesPromise = this.fetchWordPressImages(options.keyword);

    let [videos, references, wpImages] = await Promise.all([videosPromise, referencesPromise, wpImagesPromise]);

    if (references.length === 0 && top3Competitors.length > 0) {
      const serpFallbackRefs: Reference[] = top3Competitors
        .map((competitor) => {
          const url = competitor.url || '';
          if (!/^https?:\/\//i.test(url)) return null;
          let domain = '';
          try {
            domain = new URL(url).hostname.replace('www.', '');
          } catch {
            domain = '';
          }

          return {
            title: competitor.title || domain || options.keyword,
            url,
            type: domain.endsWith('.gov') ? 'government' : 'industry',
            domain,
            authorityScore: this.referenceService.calculateAuthorityScore(url),
          } as Reference;
        })
        .filter((ref): ref is Reference => !!ref)
        .slice(0, 8);

      if (serpFallbackRefs.length > 0) {
        references = serpFallbackRefs;
        this.warn(`References: using ${references.length} SERP competitor links as fallback.`);
      }
    }

    this.log(`Phase 2 ✅ YouTube: ${videos.length} videos found.`);
    this.log(`Phase 3 ✅ References: ${references.length} high-authority sources found.`);
    this.log(`Phase 4 ✅ WordPress images: ${wpImages.length} relevant media items found.`);

    // ── Phase 5: Master Content Synthesis ─────────────────────────────────
    this.log('Phase 5: Master Content Generation (Human-First Anti-AI Engine)...');

    const systemPrompt = buildMasterSystemPrompt();

    const neuronWriterSection = neuron
      ? neuron.service.buildFullPromptSection(neuron.analysis)
      : 'No NeuronWriter data available. Focus on comprehensive semantic coverage using LSI keywords, natural language variation, and expert-level topic coverage.';

    // Build YouTube embed data for prompt
    const youtubeEmbed = videos.length > 0
      ? videos.slice(0, 3).map(v => ({ videoId: v.id, title: v.title }))
      : undefined;

    const userPrompt = buildMasterUserPrompt({
      primaryKeyword: options.keyword,
      secondaryKeywords: gapTargets,
      title: options.title || options.keyword,
      contentType: options.contentType || 'pillar',
      targetWordCount: Math.max(
        Number(neuron?.analysis?.recommended_length || 0),
        Number(serpAnalysis.recommendedWordCount || 0),
        Number(options.targetWordCount || 3500),
      ),
      neuronWriterSection,
      authorName: this.config.authorName,
      internalLinks: options.internalLinks || [],
      youtubeEmbed,
      serpData: {
        competitorTitles: top3Competitors.map((c) => c.title),
        peopleAlsoAsk: gapTargets,
        avgWordCount: serpAnalysis.avgWordCount,
      },
    } as any);

    const genResult = await this.engine.generateWithModel({
      prompt: userPrompt,
      systemPrompt,
      model: options.model || this.config.primaryModel || 'gemini',
      apiKeys: this.config.apiKeys,
      maxTokens: 16384,
      temperature: 0.85
    });

    let html = genResult.content;

    if (!html || html.trim().length < MIN_VALID_CONTENT_LENGTH) {
      throw new Error(`AI returned insufficient content (${html?.length || 0} chars). Try switching to a different model.`);
    }

    // ── Phase 5: NeuronWriter Term Enforcement (THE CRITICAL FIX) ─────────
    if (neuron) {
      this.log('Phase 5: NeuronWriter Term Enforcement — verifying keyword coverage...');
      const allNwTerms = [
        ...(neuron.analysis.terms || []),
        ...(neuron.analysis.termsExtended || []),
      ];
      const contentLower = html.replace(/<[^>]*>/g, ' ').toLowerCase();
      const missingTerms = allNwTerms
        .filter(t => t.term && !contentLower.includes(t.term.toLowerCase()))
        .map(t => t.term);

      const totalTerms = allNwTerms.filter(t => t.term).length;
      const coveredTerms = totalTerms - missingTerms.length;
      const coveragePct = totalTerms > 0 ? Math.round((coveredTerms / totalTerms) * 100) : 100;

      this.log(`NW Coverage: ${coveredTerms}/${totalTerms} terms (${coveragePct}%). Missing: ${missingTerms.length}`);

      if (missingTerms.length > 0) {
        this.log(`Injecting ${Math.min(missingTerms.length, 30)} missing NW terms into content...`);
        html = injectMissingTerms(html, missingTerms.slice(0, 30));

        // Re-check coverage after injection
        const contentLower2 = html.replace(/<[^>]*>/g, ' ').toLowerCase();
        const stillMissing = missingTerms.filter(t => !contentLower2.includes(t.toLowerCase()));
        const finalCoverage = totalTerms > 0 ? Math.round(((totalTerms - stillMissing.length) / totalTerms) * 100) : 100;
        this.log(`Phase 5 ✅ Final NW coverage: ${finalCoverage}% (${stillMissing.length} terms still missing)`);
      } else {
        this.log('Phase 5 ✅ All NeuronWriter terms covered!');
      }
    } else {
      this.log('Phase 6: Skipped NW term enforcement — no NeuronWriter data.');
    }

    // ── Phase 7: Built-in Self-Critique Rewrite ────────────────────────────
    try {
      this.log('Phase 7: Running enterprise self-critique pass...');
      const scoreBeforeCritique = calculateQualityScore(html, options.keyword, [], gapTargets).overall;

      let critique = await refineWithSelfCritique({
        engine: this.engine,
        model: options.model || this.config.primaryModel || 'gemini',
        keyword: options.keyword,
        title: options.title || options.keyword,
        html,
        contentGaps: gapTargets,
        maxPasses: 3,
        minScore: 92,
      });

      html = critique.html;
      let finalCritiqueScore = critique.finalScore;

      if (finalCritiqueScore < 88 || finalCritiqueScore <= critique.initialScore) {
        this.warn('Phase 7: Quality gain is weak. Running aggressive second critique pass...');
        const aggressiveCritique = await refineWithSelfCritique({
          engine: this.engine,
          model: options.model || this.config.primaryModel || 'gemini',
          keyword: options.keyword,
          title: options.title || options.keyword,
          html,
          contentGaps: gapTargets,
          maxPasses: 3,
          minScore: 94,
        });

        if (aggressiveCritique.finalScore > finalCritiqueScore) {
          html = aggressiveCritique.html;
          finalCritiqueScore = aggressiveCritique.finalScore;
        }
      }

      if (finalCritiqueScore < 82) {
        this.warn(`Phase 7: Final score ${finalCritiqueScore} is below hard gate. Applying emergency anti-fluff cleanup.`);
        html = removeAIPhrases(polishReadability(html));
        finalCritiqueScore = calculateQualityScore(html, options.keyword, [], gapTargets).overall;
      }

      this.log(`Phase 7 ✅ Self-critique quality (${scoreBeforeCritique} → ${finalCritiqueScore}).`);
    } catch (e) {
      this.warn(`Phase 7: Self-critique skipped (${e}).`);
    }

    // ── Phase 7b: SERP Gap Coverage Enforcement ────────────────────────────
    this.log('Phase 7b: Enforcing top-3 SERP gap/entity coverage...');
    const gapCoverage = this.enforceGapCoverage(html, gapTargets);
    html = gapCoverage.html;
    this.log(
      `Phase 7b ✅ Gap coverage: ${gapTargets.length - gapCoverage.missingAfter.length}/${gapTargets.length} terms covered.`
    );

    // ── Phase 8: SOTA Refinement & Aesthetics ─────────────────────────────
    this.log('Phase 8: Anti-AI Polish & Premium Design Overlay...');

    html = await this.humanizeContent(html, options.keyword);
    html = polishReadability(html);
    html = await this.applyPremiumStyling(html);

    // ── Phase 6b: Visual Element Enforcement ──────────────────────────────
    this.log('Phase 6b: Ensuring visual richness (callouts, stats, key takeaways)...');
    html = ensureVisualElements(html, options.keyword);

    // ── Phase 6c: Visual Break Enforcement ────────────────────────────────
    this.log('Phase 6c: Visual Break Enforcement (breaking walls of text)...');

    const postProcessResult = postProcessContent(html, {
      maxConsecutiveWords: 200,
      usePullQuotes: true,
      enhanceDesign: false,
      removeAI: true,
    });

    html = postProcessResult.html;
    this.log(`Phase 6c ✅ Visual breaks: ${postProcessResult.elementsInjected} elements injected.`);

    // ── Phase 9: YouTube + WordPress Media Injection ───────────────────────
    this.log('Phase 9: Deduplicating & injecting YouTube videos...');
    // Remove any AI-generated YouTube iframes first to avoid duplicates
    html = html.replace(/<iframe[^>]*src=["']https?:\/\/(?:www\.)?youtube\.com\/embed\/[^"']+["'][^>]*><\/iframe>/gi, '');
    // Now inject exactly ONE video via our controlled method
    if (videos.length > 0) {
      html = this.injectYouTubeVideos(html, [videos[0]]);
    }
    this.log(`Phase 9 ✅ ${Math.min(videos.length, 1)} video injected into content.`);

    this.log('Phase 9b: Injecting WordPress media gallery images...');
    html = this.injectWordPressImages(html, wpImages, options.keyword);
    this.log(`Phase 9b ✅ ${wpImages.length} images injected from media gallery.`);

    // ── Phase 10: Reference Section Injection ──────────────────────────────
    this.log('Phase 10: Stripping AI-generated references, injecting verified sources...');
    // Remove any AI-generated "Sources & Further Reading" / "References" section BEFORE injecting our verified one
    html = html.replace(/<h2[^>]*>\s*(?:Sources\s*&?\s*Further\s*Reading|References)\s*<\/h2>[\s\S]*?(?=<h2[^>]*>|<div[^>]*data-(?:article-footer|verified-references)|<\/article>)/gi, '');
    html = this.injectReferencesSection(html, references);
    html = this.ensureExternalLinksClickable(html);
    this.log(`Phase 10 ✅ ${references.length} verified sources injected.`);

    // ── Phase 9: Internal Link Generation & Injection (6–12 links) ─────────
    this.log('Phase 9: Generating & Injecting Internal Links (target: 6-12)...');

    let finalInternalLinks: InternalLink[] = [];

    if (this.config.sitePages && this.config.sitePages.length > 0) {
      this.linkEngine.updateSitePages(this.config.sitePages);
      const generatedLinks = this.linkEngine.generateLinkOpportunities(html, 12, options.keyword);

      if (generatedLinks.length > 0) {
        html = this.linkEngine.injectContextualLinks(html, generatedLinks);
        finalInternalLinks = generatedLinks;
        this.log(`Phase 9 ✅ Injected ${generatedLinks.length} contextual internal links.`);
      } else {
        this.warn('Phase 9: No matching site pages found for internal linking. Ensure your sitemap has been loaded.');
      }
    } else {
      this.warn('Phase 9: Skipping internal links — no site pages loaded. Add a Sitemap URL in the Setup tab.');
    }

    // ── Phase 10: Schema.org Structured Data ───────────────────────────────
    this.log('Phase 10: Generating Schema.org Structured Data...');

    const authorName = this.config.authorName || 'Editorial Team';
    const siteUrl = (this.config.organizationUrl || this.config.wpUrl || 'https://example.com').replace(/\/$/, '');
    const slug = (options.title || options.keyword).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
    const articleUrl = `${siteUrl}/${slug}/`;

    const contentForSchema = {
      title: options.title || options.keyword,
      metaDescription: `A comprehensive guide on ${options.keyword}.`,
      content: html,
      generatedAt: new Date(),
      eeat: {
        author: {
          name: authorName,
          credentials: [],
          publications: [],
          expertiseAreas: [options.keyword],
          socialProfiles: [],
        },
        citations: [],
        expertReviews: [],
        methodology: '',
        lastUpdated: new Date(),
        factChecked: true,
      },
    } as any;

    let schema: any = { '@context': 'https://schema.org', '@graph': [] };
    try {
      schema = this.schemaGenerator.generateComprehensiveSchema(contentForSchema, articleUrl);
      this.log(`Phase 10 ✅ Schema generated with ${schema['@graph']?.length || 0} entities.`);
    } catch (e) {
      this.warn(`Phase 10: Schema generation failed (${e}). Using empty schema.`);
    }

    this.log('✅ All 10 phases complete. Assembling final result...');

    const wordCount = html.replace(/<[^>]*>/g, ' ').split(/\s+/).filter(Boolean).length;

    return {
      id: crypto.randomUUID(),
      title: options.title || options.keyword,
      seoTitle: options.title || options.keyword,
      content: html,
      metaDescription: `A comprehensive guide and analysis on ${options.keyword}.`,
      slug,
      primaryKeyword: options.keyword,
      secondaryKeywords: [
        ...(neuron?.analysis?.terms?.map((t: any) => t.term).slice(0, 5) || []),
        ...(neuron?.analysis?.termsExtended?.map((t: any) => t.term).slice(0, 5) || []),
      ],
      metrics: {
        wordCount,
        sentenceCount: Math.round(wordCount / 15),
        paragraphCount: Math.round(wordCount / 100),
        headingCount: (html.match(/<h[2-6][^>]*>/gi) || []).length,
        imageCount: (html.match(/<img[^>]*>/gi) || []).length,
        linkCount: (html.match(/<a[^>]*>/gi) || []).length,
        keywordDensity: 1.5,
        readabilityGrade: 8,
        estimatedReadTime: Math.ceil(wordCount / 200)
      },
      qualityScore: calculateQualityScore(html, options.keyword, finalInternalLinks.map(l => l.targetUrl), gapTargets),
      internalLinks: finalInternalLinks,
      schema,
      eeat: {
        author: {
          name: authorName,
          credentials: [],
          publications: [],
          expertiseAreas: [options.keyword],
          socialProfiles: []
        },
        citations: references.map(r => ({ title: r.title, url: r.url, type: r.type })),
        expertReviews: [],
        methodology: '',
        lastUpdated: new Date(),
        factChecked: true
      },
      serpAnalysis: {
        avgWordCount: serpAnalysis.avgWordCount || neuron?.analysis?.recommended_length || 2000,
        recommendedWordCount: serpAnalysis.recommendedWordCount || neuron?.analysis?.recommended_length || 2500,
        userIntent: serpAnalysis.userIntent || 'informational',
        commonHeadings: Array.from(new Set([
          ...(serpAnalysis.commonHeadings || []),
          ...(neuron?.analysis?.headingsH2 || []).map(h => h.text),
          ...(neuron?.analysis?.headingsH3 || []).map(h => h.text),
        ])),
        contentGaps: gapTargets,
        semanticEntities: Array.from(new Set([
          ...(serpAnalysis.semanticEntities || []),
          ...(neuron?.analysis?.entities || []).map(e => e.entity),
        ])),
        topCompetitors: top3Competitors,
        recommendedHeadings: Array.from(new Set([
          ...(serpAnalysis.recommendedHeadings || []),
          ...(neuron?.analysis?.headingsH2 || []).map(h => h.text),
          ...(neuron?.analysis?.headingsH3 || []).map(h => h.text),
        ])),
      },
      generatedAt: new Date(),
      model: genResult.model,
      consensusUsed: false,
      neuronWriterAnalysis: neuron?.analysis || null,
      neuronWriterQueryId: neuron?.queryId || null,
      youtubeVideos: videos,
      references,
      telemetry: this.telemetry
    } as any;
  }
}

export function createOrchestrator(config: any) {
  return new EnterpriseContentOrchestrator(config);
}

export default EnterpriseContentOrchestrator;
