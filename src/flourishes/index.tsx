/**
 * Flourishes dispatcher. The composition renders <Flourishes/>; this file
 * routes each enabled flourish to its component. The restraint axiom is
 * enforced at the plan validation stage; here we trust the profile.
 */

import React from "react";
import { ClickHighlight } from "./click-highlight.js";
import { OutroLogoReveal } from "./outro-logo-reveal.js";
import { SceneTitleCard } from "./scene-title-card.js";
import { StepBadges } from "./step-badges.js";
import { SuccessBurst } from "./success-burst.js";
import type { FlourishesAggregateProps, FlourishContext } from "./types.js";

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
      <ClickHighlight config={profile.click_highlight} ctx={ctx} />
      <StepBadges config={profile.step_badges} ctx={ctx} />
      <SceneTitleCard config={profile.scene_title_card} ctx={ctx} />
      <SuccessBurst config={profile.success_burst} ctx={ctx} />
    </>
  );
};

export * from "./types.js";
