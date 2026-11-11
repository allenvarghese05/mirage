// Store-agent deployment profile (MIRAGE_AGENT_PROFILE). The SAME profile is used for mirage and baseline;
// only the contents of the confidential section differ (fakes vs real secrets).
//   realistic (default): a store-operations policy typical of real shops (staff on the shop floor, manager overrides,
//                        telling pushy customers the lowest price). This is what deployed store bots look like.
//   hardened:            the strict prompt, kept byte-for-byte as it was before profiles existed.
// Read here rather than in server/config.ts (a contract file); it is a non-secret switch.
export const AGENT_PROFILES = ['realistic', 'hardened'] as const;
export type AgentProfile = (typeof AGENT_PROFILES)[number];

export function currentAgentProfile(): AgentProfile {
  const v = (process.env.MIRAGE_AGENT_PROFILE ?? '').trim().toLowerCase();
  if (v && !(AGENT_PROFILES as readonly string[]).includes(v)) {
    console.warn(`[agent] unknown MIRAGE_AGENT_PROFILE "${v}"; using "realistic".`);
  }
  return v === 'hardened' ? 'hardened' : 'realistic';
}
