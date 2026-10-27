import type { ThemeId } from "./page-theme.js";

interface EffortPalette {
  stops: readonly [string, string, string, string, string];
  halo: string;
}

/** Approximate unlit colors inferred from the user's screenshots; keep calibration here. */
export const EFFORT_PALETTES: Record<ThemeId, EffortPalette> = {
  blue: { stops: ["#303BC7", "#634ADC", "#893DEB", "#7838EC", "#7E47F0"], halo: "#B6B7FF" },
  green: { stops: ["#30564D", "#55578D", "#8244D8", "#7F42DF", "#8757D8"], halo: "#B0B6DC" },
  yellow: { stops: ["#783B2B", "#79446E", "#8D43D7", "#8A3CD6", "#9756CB"], halo: "#BCAADE" },
  pink: { stops: ["#831584", "#942BB7", "#943FE5", "#882BDD", "#9840D9"], halo: "#F1A7E5" },
  orange: { stops: ["#90203B", "#863D83", "#9441D5", "#9037DC", "#9E4DD1"], halo: "#C4A1EA" },
  purple: { stops: ["#6F30CD", "#7C38DC", "#8035E9", "#843AED", "#8842EB"], halo: "#B79AFF" },
  default: { stops: ["#6E7DF2", "#7656E9", "#6924CF", "#783AE7", "#7C46EE"], halo: "#B4C0FF" }
};

const BURST_DEPTHS = [
  { name: "near", size: [3.5, 4.5], radius: [22, 27], duration: [500, 560], delay: [0, 20], opacity: .9, color: "#d9b8ff" },
  { name: "middle", size: [2.5, 3.5], radius: [29, 35], duration: [560, 630], delay: [45, 70], opacity: .75, color: "#dfc6ff" },
  { name: "far", size: [1.8, 2.8], radius: [36, 44], duration: [630, 700], delay: [90, 110], opacity: .6, color: "#e7d5ff" }
] as const;
const MAX_BURST_RADIUS = 44;

export const EFFORT_EFFECTS_CSS = `
.effort-card{position:relative;overflow:clip}
.range-value{transition:color 180ms ease}
.effort-card[data-max='true'] .range-value{color:#924ff7}
.range-dots{transition:opacity 150ms ease}
.effort-card[data-max='true'] .range-dots{opacity:0}
.max-fill{position:absolute;inset:0 auto 0 0;width:var(--range-progress);border-radius:inherit;overflow:hidden;pointer-events:none;transition:width 220ms cubic-bezier(.2,.8,.2,1)}
.max-surface{position:absolute;inset:0;opacity:0;background:var(--max-gradient);mask-image:linear-gradient(90deg,transparent 38.4615%,#000 61.5385%);mask-size:260% 100%;mask-position:100% 0%;mask-repeat:no-repeat;isolation:isolate;pointer-events:none}
.max-glow-motion{position:absolute;inset:0;transform-origin:0 50%;pointer-events:none}
.max-glow{position:absolute;left:calc(var(--halo-width) / -2);top:-80%;width:var(--halo-width);height:260%;border-radius:50%;background:radial-gradient(ellipse,var(--max-halo) 0%,var(--max-halo) 18%,transparent 72%)}
.max-glow--pale{background:radial-gradient(ellipse,#f2ecff 0%,#f2ecff 22%,transparent 76%)}
.max-particle{position:absolute;left:0;width:100%;height:0;transform:translate3d(var(--particle-rest-x),0,0);animation:effort-particle-travel var(--travel-time) linear var(--travel-delay) infinite;pointer-events:none}
.max-particle-core{position:absolute;display:block;width:var(--particle-size);height:var(--particle-size);border-radius:50%;background:#fff;transform:translate(-50%,-50%);animation:effort-particle-twinkle var(--twinkle-time) ease-in-out var(--twinkle-delay) infinite alternate}
.effort-card[data-effects-running='false'] .max-particle,.effort-card[data-effects-running='false'] .max-particle-core{animation-play-state:paused}
@keyframes effort-particle-travel{from{transform:translate3d(103%,0,0)}to{transform:translate3d(-3%,0,0)}}
@keyframes effort-particle-twinkle{from{opacity:.15}to{opacity:.60}}
.max-burst-layer{position:absolute;z-index:3;left:var(--range-progress);top:50%;width:0;height:0;pointer-events:none}
.max-burst-depth{position:absolute;left:0;top:0;width:0;height:0;pointer-events:none}
.max-burst-particle{position:absolute;left:0;top:0;width:3px;height:3px;border-radius:50%;background:#d9b8ff;box-shadow:0 0 3px #924ff755;opacity:0;pointer-events:none}
@media(prefers-reduced-motion:reduce){.range-value,.range-dots,.max-fill{transition:none}.max-particle,.max-particle-core{animation:none}.max-particle-core{opacity:.35}}
`;

type EffectPhase = "ordinary" | "entering" | "steady" | "leaving";

interface GlowPosition {
  x: number;
  y: number;
  scale: number;
  opacity: number;
}

interface Glow {
  node: HTMLElement;
  pale: boolean;
  position: GlowPosition;
  animation: Animation | null;
}

interface BurstBounds {
  left: number;
  right: number;
  top: number;
  bottom: number;
  radius: number;
}

/** Decoration only. Native range values, persistence and model operations stay in the controller. */
export class EffortEffects {
  private card: HTMLElement | null = null;
  private surface: HTMLElement | null = null;
  private fill: HTMLElement | null = null;
  private burstLayer: HTMLElement | null = null;
  private glows: Glow[] = [];
  private burstAnimations = new Set<Animation>();
  private transition: Animation | null = null;
  private burstTimer: number | null = null;
  private highest = false;
  private visible = false;
  private phase: EffectPhase = "ordinary";
  private theme: ThemeId = "purple";
  private generation = 0;
  private readonly view: Window;
  private readonly motionPreference: MediaQueryList | null;

  constructor(private readonly document: Document) {
    this.view = document.defaultView!;
    this.motionPreference = this.view.matchMedia?.("(prefers-reduced-motion: reduce)") ?? null;
    this.motionPreference?.addEventListener("change", () => {
      this.settle();
      this.syncAmbient();
    });
  }

  attach(card: HTMLElement, track: HTMLElement, shell: HTMLElement, highest: boolean): void {
    this.detach();
    this.card = card;
    const fill = this.element("max-fill");
    fill.setAttribute("aria-hidden", "true");
    const surface = this.element("max-surface");
    fill.append(surface);
    const dots = track.querySelector(".range-dots");
    track.insertBefore(fill, dots);
    this.fill = fill;
    this.surface = surface;
    this.createGlows(surface);
    this.createParticles(surface);
    const burst = this.element("max-burst-layer");
    burst.setAttribute("aria-hidden", "true");
    shell.append(burst);
    this.burstLayer = burst;
    this.setTheme(this.theme);
    this.highest = highest;
    this.settle();
    this.syncAmbient();
  }

  detach(): void {
    this.cancelTransient();
    for (const glow of this.glows) {
      if (glow.animation) {
        glow.animation.onfinish = null;
        glow.animation.cancel();
      }
    }
    this.glows = [];
    this.fill?.remove();
    this.burstLayer?.remove();
    this.card?.removeAttribute("data-max");
    this.card?.removeAttribute("data-max-phase");
    this.card?.removeAttribute("data-max-theme");
    this.card?.removeAttribute("data-effects-running");
    this.card = this.surface = this.fill = this.burstLayer = null;
    this.highest = false;
    this.phase = "ordinary";
  }

  setTheme(theme: ThemeId): void {
    const changed = this.theme !== theme;
    this.theme = theme;
    const palette = EFFORT_PALETTES[theme];
    this.card?.style.setProperty("--max-gradient", "linear-gradient(90deg," +
      palette.stops.map((color, index) => color + " " + index * 25 + "%").join(",") + ")");
    this.card?.style.setProperty("--max-halo", palette.halo);
    if (this.card) this.card.dataset.maxTheme = theme;
    if (changed && (this.phase === "entering" || this.phase === "leaving")) {
      this.settle();
      this.syncAmbient();
    }
  }

  setVisible(visible: boolean): void {
    this.visible = visible;
    if (!visible && (this.phase === "entering" || this.phase === "leaving" ||
      this.burstTimer !== null || this.burstAnimations.size > 0)) this.settle();
    this.syncAmbient();
  }

  setHighest(highest: boolean, source: "user" | "restore" = "restore"): void {
    if (!this.card || !this.surface || this.highest === highest) return;
    this.highest = highest;
    this.card.dataset.max = String(highest);
    if (source !== "user" || !this.visible || this.reducedMotion || !this.surface.animate) {
      this.settle();
      this.syncAmbient();
      return;
    }
    const current = this.view.getComputedStyle(this.surface);
    const opacity = Number(current.opacity) || 0;
    const maskPosition = current.maskPosition;
    this.cancelTransient();
    const generation = this.generation;
    this.phase = highest ? "entering" : "leaving";
    this.card.dataset.maxPhase = this.phase;
    if (highest) {
      this.surface.style.opacity = "1";
      this.surface.style.maskPosition = "100% 0%";
      // A 0.6-track-wide alpha ramp blends the new palette over the old theme.
      // At the midpoint, the left stays native, the middle blends, and the right is purple.
      this.transition = this.surface.animate([
        { opacity: opacity > .01 ? opacity : 1, maskPosition: opacity > .01 ? maskPosition : "0% 0%" },
        { opacity: 1, maskPosition: "100% 0%" }
      ], { duration: 1200, easing: "cubic-bezier(.25,.6,.25,1)", fill: "both" });
      this.burstTimer = this.view.setTimeout(() => {
        this.burstTimer = null;
        if (generation === this.generation && this.highest && this.canRun) this.playBurst();
      }, 220);
    } else {
      this.surface.style.opacity = "0";
      this.surface.style.maskPosition = "100% 0%";
      this.transition = this.surface.animate([
        { opacity, maskPosition }, { opacity: 0, maskPosition }
      ], { duration: 200, easing: "ease-out", fill: "both" });
    }
    const transition = this.transition;
    transition.onfinish = () => {
      if (generation !== this.generation || this.transition !== transition) return;
      transition.onfinish = null;
      transition.cancel();
      this.transition = null;
      this.phase = this.highest ? "steady" : "ordinary";
      if (this.card) this.card.dataset.maxPhase = this.phase;
      this.syncAmbient();
    };
    this.syncAmbient();
  }

  private get reducedMotion(): boolean {
    return this.motionPreference?.matches ?? false;
  }

  private get canRun(): boolean {
    return this.visible && !this.reducedMotion && Boolean(this.card?.isConnected) && this.phase !== "ordinary";
  }

  private settle(): void {
    this.cancelTransient();
    this.phase = this.highest ? "steady" : "ordinary";
    if (this.card) {
      this.card.dataset.max = String(this.highest);
      this.card.dataset.maxPhase = this.phase;
    }
    if (this.surface) {
      this.surface.style.opacity = this.highest ? "1" : "0";
      this.surface.style.maskPosition = "100% 0%";
    }
  }

  private cancelTransient(): void {
    this.generation += 1;
    if (this.burstTimer !== null) this.view.clearTimeout(this.burstTimer);
    this.burstTimer = null;
    if (this.transition) {
      this.transition.onfinish = null;
      this.transition.cancel();
      this.transition = null;
    }
    for (const animation of this.burstAnimations) {
      animation.onfinish = null;
      animation.cancel();
    }
    this.burstAnimations.clear();
    this.burstLayer?.replaceChildren();
  }

  private createGlows(surface: HTMLElement): void {
    for (let index = 0; index < 3; index += 1) {
      const node = this.element("max-glow-motion");
      const pale = index === 2;
      const halo = this.element("max-glow" + (pale ? " max-glow--pale" : ""));
      halo.style.setProperty("--halo-width", String(pale ? this.random(55, 75) : this.random(35, 65)) + "%");
      node.append(halo);
      const position = { x: pale ? 50 : index * 35 + 10, y: this.random(-20, 20), scale: 1, opacity: .28 };
      this.applyGlowPosition(node, position);
      surface.append(node);
      this.glows.push({ node, pale, position, animation: null });
    }
  }

  private createParticles(surface: HTMLElement): void {
    for (let index = 0; index < 18; index += 1) {
      const dot = this.element("max-particle");
      const size = this.random(1.4, 2.6);
      const travelTime = this.random(1.6, 2.4);
      dot.style.setProperty("--particle-size", String(size) + "px");
      dot.style.setProperty("--particle-rest-x", String(this.random(3, 96)) + "%");
      dot.style.top = String(this.random(15, 80)) + "%";
      dot.style.setProperty("--travel-time", String(travelTime) + "s");
      dot.style.setProperty("--travel-delay", String(this.random(-travelTime, 0)) + "s");
      dot.style.setProperty("--twinkle-time", String(this.random(1.8, 3.4)) + "s");
      dot.style.setProperty("--twinkle-delay", String(this.random(-3.4, 0)) + "s");
      dot.append(this.element("max-particle-core"));
      surface.append(dot);
    }
  }

  private syncAmbient(): void {
    const running = this.canRun;
    if (this.card) this.card.dataset.effectsRunning = String(running);
    for (const glow of this.glows) {
      if (glow.animation) {
        if (running && glow.animation.playState === "paused") glow.animation.play();
        else if (!running && glow.animation.playState === "running") glow.animation.pause();
      } else if (running) this.moveGlow(glow);
    }
  }

  private moveGlow(glow: Glow): void {
    if (!this.canRun || !glow.node.animate) return;
    // Keep each segment visibly moving while allowing independent changes of direction.
    const canMoveLeft = glow.position.x >= 22;
    const canMoveRight = glow.position.x <= 78;
    const moveLeft = canMoveLeft && (!canMoveRight || this.random(0, 1) < .5);
    const next: GlowPosition = {
      x: moveLeft ? this.random(0, glow.position.x - 22) : this.random(glow.position.x + 22, 100),
      y: this.random(-35, 35), scale: this.random(.9, 1.15),
      opacity: glow.pale ? this.random(.22, .36) : this.random(.20, .35)
    };
    const animation = glow.node.animate([
      { transform: this.glowTransform(glow.position), opacity: glow.position.opacity },
      { transform: this.glowTransform(next), opacity: next.opacity }
    ], { duration: this.random(5000, 9000), easing: "cubic-bezier(.45,0,.55,1)", fill: "both" });
    glow.animation = animation;
    animation.onfinish = () => {
      if (glow.animation !== animation) return;
      animation.onfinish = null;
      this.applyGlowPosition(glow.node, next);
      glow.position = next;
      glow.animation = null;
      animation.cancel();
      if (this.canRun) this.moveGlow(glow);
    };
  }

  private playBurst(): void {
    if (!this.burstLayer?.animate || !this.card) return;
    const card = this.card.getBoundingClientRect();
    const origin = this.burstLayer.getBoundingClientRect();
    if (card.width <= 0 || card.height <= 0) return;
    const bounds: BurstBounds = {
      left: card.left - origin.left, right: card.right - origin.left,
      top: card.top - origin.top, bottom: card.bottom - origin.top,
      radius: parseFloat(this.view.getComputedStyle(this.card).borderTopLeftRadius) || 0
    };
    for (const [depthIndex, depth] of BURST_DEPTHS.entries()) {
      const layer = this.element("max-burst-depth");
      layer.dataset.depth = depth.name;
      layer.style.zIndex = String(BURST_DEPTHS.length - depthIndex);
      this.burstLayer.append(layer);
      for (let index = 0; index < 6; index += 1) {
        const dot = this.element("max-burst-particle");
        const size = this.random(depth.size[0], depth.size[1]);
        dot.style.width = dot.style.height = String(size) + "px";
        dot.style.left = dot.style.top = String(-size / 2) + "px";
        dot.style.background = depth.color;
        const angle = (index + this.random(-.18, .18)) / 6 * Math.PI * 2 + depthIndex * Math.PI / 9;
        const x = Math.cos(angle);
        const y = Math.sin(angle);
        const available = this.availableBurstRadius(x, y, bounds, size / 2 + 1);
        const start = Math.min(16, available * .75);
        // Compress all depths against the same outer radius, preserving their order.
        const travelScale = Math.min(1, Math.max(0, (available - start) / (MAX_BURST_RADIUS - 16)));
        const distance = start + (this.random(depth.radius[0], depth.radius[1]) - 16) * travelScale;
        const peak = start + (distance - start) * .55;
        const at = (radius: number, scale: number) => "translate3d(" + x * radius + "px," + y * radius + "px,0) scale(" + scale + ")";
        layer.append(dot);
        const animation = dot.animate([
          { transform: at(start, .7), opacity: 0 },
          { transform: at(peak, 1), opacity: depth.opacity, offset: .22 },
          { transform: at(distance, .65), opacity: 0 }
        ], {
          duration: this.random(depth.duration[0], depth.duration[1]), delay: this.random(depth.delay[0], depth.delay[1]),
          easing: "cubic-bezier(.18,.7,.28,1)", fill: "both"
        });
        this.burstAnimations.add(animation);
        animation.onfinish = () => {
          animation.onfinish = null;
          this.burstAnimations.delete(animation);
          animation.cancel();
          dot.remove();
          if (!layer.hasChildNodes()) layer.remove();
        };
      }
    }
  }

  private availableBurstRadius(x: number, y: number, bounds: BurstBounds, inset: number): number {
    const left = bounds.left + inset;
    const right = bounds.right - inset;
    const top = bounds.top + inset;
    const bottom = bounds.bottom - inset;
    const radius = Math.max(0, Math.min(bounds.radius - inset, (right - left) / 2, (bottom - top) / 2));
    const inside = (distance: number) => {
      const px = x * distance;
      const py = y * distance;
      if (px < left || px > right || py < top || py > bottom) return false;
      const cx = Math.max(left + radius, Math.min(right - radius, px));
      const cy = Math.max(top + radius, Math.min(bottom - radius, py));
      return (px - cx) ** 2 + (py - cy) ** 2 <= radius ** 2;
    };
    if (inside(MAX_BURST_RADIUS)) return MAX_BURST_RADIUS;
    // A bounded calculation at entry only; movement itself stays in WAAPI.
    let low = 0;
    let high = MAX_BURST_RADIUS;
    for (let step = 0; step < 12; step += 1) {
      const middle = (low + high) / 2;
      if (inside(middle)) low = middle;
      else high = middle;
    }
    return low;
  }

  private applyGlowPosition(node: HTMLElement, position: GlowPosition): void {
    node.style.transform = this.glowTransform(position);
    node.style.opacity = String(position.opacity);
  }

  private glowTransform(position: GlowPosition): string {
    return "translate3d(" + position.x + "%," + position.y + "%,0) scale(" + position.scale + ")";
  }

  private element(className: string): HTMLElement {
    const element = this.document.createElement("div");
    element.className = className;
    return element;
  }

  private random(min: number, max: number): number {
    return min + Math.random() * (max - min);
  }
}
