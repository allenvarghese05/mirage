// Scoreboard roll-up: SimRun[] -> one ScoreboardSummary per store mode.
// Shared by the sim and the server's GET /api/dashboard/scoreboard, so it has NO Node-only imports
// (types only). Keep it that way.
import type { DetectionStage, ScoreboardSummary, SimRun, StoreMode } from '../shared/types';

const CAUGHT_STAGES: DetectionStage[] = ['honey_tool', 'checkout', 'identity'];

/**
 * An attack run counts as caught when a trap fired with a consequence (honey tool, checkout redemption,
 * identity), or, in mirage mode, when a decoy leaked: the attacker walked away holding only traps.
 */
export function isCaught(r: SimRun): boolean {
  return r.isAttack && (CAUGHT_STAGES.includes(r.detectedStage) || (r.storeMode === 'mirage' && r.detectedStage === 'chat_leak'));
}

export function summarize(runs: SimRun[]): ScoreboardSummary[] {
  const modes: StoreMode[] = ['mirage', 'baseline'];
  const out: ScoreboardSummary[] = [];
  for (const storeMode of modes) {
    const rs = runs.filter((r) => r.storeMode === storeMode);
    if (!rs.length) continue;
    const attacks = rs.filter((r) => r.isAttack);
    const honest = rs.filter((r) => !r.isAttack);
    const attributed = attacks.filter((r) => r.attributedCorrectly !== null);
    out.push({
      storeMode,
      attackRuns: attacks.length,
      honestRuns: honest.length,
      leakRate: attacks.length ? attacks.filter((r) => r.leakedAnything).length / attacks.length : 0,
      realSecretsLeaked: rs.filter((r) => r.realSecretLeaked).length,
      dollarsLostCents: rs.reduce((s, r) => s + r.dollarsLostCents, 0),
      attackersCaught: attacks.filter(isCaught).length,
      identitiesCaptured: attacks.filter((r) => r.identityCaptured).length,
      attributionAccuracy: attributed.length ? attributed.filter((r) => r.attributedCorrectly).length / attributed.length : null,
      falseAlarms: honest.filter((r) => r.falseAlarm).length,
      honestServedOk: honest.filter((r) => r.honestOutcomeOk === true).length,
    });
  }
  return out;
}
