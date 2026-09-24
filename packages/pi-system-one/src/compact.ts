import type { ExtensionContext, SessionBeforeCompactEvent } from '@earendil-works/pi-coding-agent';
import { capState, type SystemOneClient } from './system-one.js';
import type { SystemOneAnswerResult, NoulQuestionConfig } from './types.js';

export interface CompactResult {
  summary: string;
  kept: number;
  considered: number;
  skipped?: 'disabled' | 'unconfigured' | 'empty' | 'incomplete' | 'error';
}

const MAX_ENTRIES = 24;
const KEEP_THRESHOLD = 0.55;

/** System One-guided compaction summary. Original user/assistant meaning is never rewritten in place. */
export class SystemOneCompactor {
  public enabled: boolean;

  constructor(
    private systemOneClient: SystemOneClient,
    enabled = false,
  ) {
    this.enabled = enabled;
  }

  public setEnabled(enabled: boolean): void {
    this.enabled = enabled;
  }

  public async compact(
    event: SessionBeforeCompactEvent,
    _ctx: ExtensionContext,
  ): Promise<CompactResult> {
    if (!this.enabled) return { summary: '', kept: 0, considered: 0, skipped: 'disabled' };
    if (!this.systemOneClient.isConfigured())
      return { summary: '', kept: 0, considered: 0, skipped: 'unconfigured' };

    const preparation = event.preparation;
    if (!preparation) return { summary: '', kept: 0, considered: 0, skipped: 'incomplete' };
    // Pi's preparation is the exact history being removed, including a split turn.
    const entries = [...preparation.messagesToSummarize, ...preparation.turnPrefixMessages];
    if (entries.length === 0) return { summary: '', kept: 0, considered: 0, skipped: 'empty' };
    const incomplete = (): CompactResult => ({
      summary: '',
      kept: 0,
      considered: entries.length,
      skipped: 'incomplete',
    });
    // A bounded judgment must never replace history it did not cover. Let Pi's
    // normal compactor handle histories that cannot fit in this request.
    if (entries.length > MAX_ENTRIES) return incomplete();

    try {
      const candidates = entries.map((entry, index) => ({
        index,
        text: JSON.stringify(entry),
        candidate: entry.role === 'toolResult',
      }));
      const state = {
        goal: event.customInstructions ?? "Continue the user's ongoing coding task",
        previous_summary: preparation.previousSummary ?? '',
        entries: candidates,
      };
      const capped = capState(state);
      if (capped.truncatedChars > 0 || capped.truncatedItems > 0) return incomplete();
      const questions: Record<string, NoulQuestionConfig> = {};
      for (const item of candidates) {
        if (item.candidate) {
          questions[`keep_${item.index}`] = {
            type: 'noul',
            instructions: {
              question: 'Should `entries[i]` remain available in compacted context?',
              inspect: `entries[${item.index}]`,
              goal: '`goal`',
              note: 'Judge only this entry. Keep it when later work still needs what it holds; drop it when nothing is lost.',
            },
            criteria: {
              true: {
                what: 'The entry holds something the ongoing task still needs',
                examples: [
                  "A failing test's exact error and file path",
                  'A constraint the user stated',
                ],
              },
              false: {
                what: 'The entry can be dropped without losing anything needed',
                examples: ['A superseded intermediate directory listing'],
              },
            },
          };
        }
      }

      const answers: Record<string, SystemOneAnswerResult> = Object.keys(questions).length
        ? (
            await this.systemOneClient.evaluate(
              {
                state,
                questions,
              },
              event.signal,
            )
          ).answers
        : {};

      const kept: string[] = [];
      for (const item of candidates) {
        const probability = item.candidate ? answers[`keep_${item.index}`]?.value : 1;
        if (
          typeof probability !== 'number' ||
          !Number.isFinite(probability) ||
          probability < 0 ||
          probability > 1
        ) {
          return incomplete();
        }
        if (probability >= KEEP_THRESHOLD) kept.push(`[entry ${item.index}] ${item.text}`);
      }

      const summary = [
        'System One compaction summary (tool history retained selectively; user/assistant intent preserved):',
        event.customInstructions ? `Goal: ${event.customInstructions}` : '',
        preparation.previousSummary ? `Previous summary:\n${preparation.previousSummary}` : '',
        kept.length
          ? kept.join('\n')
          : 'No historical tool entries were judged necessary to retain.',
      ]
        .filter(Boolean)
        .join('\n');
      return { summary, kept: kept.length, considered: candidates.length };
    } catch {
      return { summary: '', kept: 0, considered: entries.length, skipped: 'error' };
    }
  }
}
