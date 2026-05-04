/**
 * Flourishes dispatcher. The composition renders <Flourishes/>; this file
 * routes each enabled flourish to its component. The restraint axiom is
 * enforced at the plan validation stage; here we trust the profile.
 */

import React from "react";
import { OutroLogoReveal } from "./outro-logo-reveal.js";
import { SceneTitleCard } from "./scene-title-card.js";
import { StepBadges } from "./step-badges.js";
import { SuccessBurst } from "./success-burst.js";
import type { FlourishesAggregateProps, FlourishContext } from "./types.js";

// NOTE: ClickHighlight is intentionally NOT exported from here. It's
// rendered IN-STAGE (inside compositor/stage.tsx via composition.tsx)
// because it needs to share the recording's coordinate space — see
// compositor/stage.tsx for the architectural invariant. Other flourishes
// in this dispatcher are canvas-level (step badges in corner, scene
// title card overlay, outro reveal centered, success burst at click
// point but okay-ish without per-pixel precision).

export const Flourishes: React.FC<FlourishesAggregateProps> = ({
  profile,
  brand,
  events,
  t_ms,
  total_duration_ms,
}) => {
  if (!profile.enabled) return null;

  const ctx: FlourishContext = {
    brand,
    events,
    t_ms,
    total_duration_ms: total_duration_ms ?? Math.max(...events.map((e) => e.t_ms)),
  };

  return (
    <>
      <OutroLogoReveal config={profile.outro_logo_reveal} ctx={ctx} />
      {/* ClickHighlight rendered separately in-stage (see composition.tsx) */}
      <StepBadges config={profile.step_badges} ctx={ctx} />
      <SceneTitleCard config={profile.scene_title_card} ctx={ctx} />
      <SuccessBurst config={profile.success_burst} ctx={ctx} />
    </>
  );
};

export * from "./types.js";
