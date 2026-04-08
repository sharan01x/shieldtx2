// Shield TX — interactions
// 1. Decode animation on .decode elements (per brand book spec)
// 2. Scroll-triggered reveal for .reveal elements

(() => {
  const CHARSET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789@#$%&*!?";
  const SCRAMBLE_FRAMES = 4;
  const SCRAMBLE_INTERVAL = 50;
  const RESOLVE_INTERVAL = 22;
  const RESOLVE_STEP = 3;

  function randomChar() {
    return CHARSET[Math.floor(Math.random() * CHARSET.length)];
  }

  // Walks the element's text nodes, preserving structure (br, em, etc.)
  function decodeElement(el) {
    if (el.dataset.decoded === "true") return;
    el.dataset.decoded = "true";

    // Collect text nodes with their original text and global offset range
    const textNodes = [];
    let totalChars = 0;
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT, null);
    let node;
    while ((node = walker.nextNode())) {
      const text = node.nodeValue;
      if (text.trim().length === 0) continue;
      textNodes.push({ node, original: text, start: totalChars });
      totalChars += text.length;
    }

    if (textNodes.length === 0) return;

    // Render: for global resolve cursor `cursor`, characters with global index < cursor
    // are shown as original; others are scrambled (or kept if whitespace).
    function render(cursor) {
      textNodes.forEach(({ node, original, start }) => {
        let out = "";
        for (let i = 0; i < original.length; i++) {
          const c = original[i];
          if (c === " " || c === "\n" || c === "\t") {
            out += c;
            continue;
          }
          if (start + i < cursor) {
            out += c;
          } else {
            out += randomChar();
          }
        }
        node.nodeValue = out;
      });
    }

    // Scramble phase: cursor stays at 0
    let scrambleCount = 0;
    render(0);

    const scrambleTimer = setInterval(() => {
      scrambleCount++;
      render(0);
      if (scrambleCount >= SCRAMBLE_FRAMES) {
        clearInterval(scrambleTimer);
        startResolve();
      }
    }, SCRAMBLE_INTERVAL);

    function startResolve() {
      let cursor = 0;
      const resolveTimer = setInterval(() => {
        cursor += RESOLVE_STEP;
        if (cursor >= totalChars) {
          clearInterval(resolveTimer);
          textNodes.forEach(({ node, original }) => {
            node.nodeValue = original;
          });
          return;
        }
        render(cursor);
      }, RESOLVE_INTERVAL);
    }
  }

  // IntersectionObserver to trigger decode + reveal on viewport entry
  const decodeObserver = new IntersectionObserver(
    (entries) => {
      entries.forEach((entry) => {
        if (entry.isIntersecting) {
          decodeElement(entry.target);
          decodeObserver.unobserve(entry.target);
        }
      });
    },
    { threshold: 0.4 }
  );

  const revealObserver = new IntersectionObserver(
    (entries) => {
      entries.forEach((entry) => {
        if (entry.isIntersecting) {
          entry.target.classList.add("visible");
          revealObserver.unobserve(entry.target);
        }
      });
    },
    { threshold: 0.15, rootMargin: "0px 0px -40px 0px" }
  );

  function init() {
    document.querySelectorAll(".decode").forEach((el) => {
      decodeObserver.observe(el);
    });
    // Stagger only inside the same parent group, not globally
    const groups = new Map();
    document.querySelectorAll(".reveal").forEach((el) => {
      const parent = el.parentElement;
      const list = groups.get(parent) || [];
      list.push(el);
      groups.set(parent, list);
    });
    groups.forEach((list) => {
      list.forEach((el, i) => {
        el.style.transitionDelay = `${i * 60}ms`;
        revealObserver.observe(el);
      });
    });

    initParallax();
    initQuadtree();
    initHeroMotion();
  }

  // ============================================
  // HERO MOTION — entry reveal + scroll parallax on visual
  // ============================================
  function initHeroMotion() {
    const hero = document.querySelector(".hero-panel");
    if (!hero) return;
    hero.classList.add("hero-loaded");

    const visual = hero.querySelector(".hero-visual");
    if (!visual) return;

    let ticking = false;
    function update() {
      ticking = false;
      const rect = hero.getBoundingClientRect();
      // 0 when hero at top of viewport, 1 when scrolled past
      const progress = Math.max(0, Math.min(1, -rect.top / rect.height));
      if (progress <= 0) {
        // Let CSS reveal animation own the initial state
        visual.style.transform = "";
        visual.style.opacity = "";
        return;
      }
      const translate = progress * 60;
      const scale = 1 - progress * 0.04;
      const opacity = 1 - progress * 0.6;
      visual.style.transform = `translate3d(0, ${translate.toFixed(1)}px, 0) scale(${scale.toFixed(3)})`;
      visual.style.opacity = opacity.toFixed(3);
    }
    function onScroll() {
      if (!ticking) {
        requestAnimationFrame(update);
        ticking = true;
      }
    }
    window.addEventListener("scroll", onScroll, { passive: true });
  }

  // ============================================
  // QUADTREE PIXELATOR — variance-based adaptive pixelation inside a circular hover brush
  // Ported from quadtree-pixelator.html: flat mean-color tiles that subdivide
  // where the image has high local variance (edges/detail).
  // ============================================
  function initQuadtree() {
    document.querySelectorAll(".qtcanvas").forEach((canvas) => {
      const srcUrl = canvas.dataset.src;
      if (!srcUrl) return;

      const ctx = canvas.getContext("2d");
      const img = new Image();

      // Tunables
      const CELL = 14;              // base tile size (px in image space)
      const MIN_TILE = 2;
      const VARIANCE_THRESH = 3000; // higher = less subdivision; ~pixelator refraction 0.65
      const BRUSH_RADIUS_FRAC = 0.28; // brush radius as fraction of min(imgW,imgH)

      let sourceData = null; // ImageData of the image at native size
      let sourceW = 0, sourceH = 0;

      const state = {
        target: { x: 0.5, y: 0.5, influence: 0 },
        current: { x: 0.5, y: 0.5, influence: 0 },
        running: false,
      };

      function resize() {
        const rect = canvas.getBoundingClientRect();
        const dpr = Math.min(window.devicePixelRatio || 1, 2);
        canvas.width = Math.max(1, Math.floor(rect.width * dpr));
        canvas.height = Math.max(1, Math.floor(rect.height * dpr));
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        draw();
      }

      // Variance-based quadtree applied to an ImageData region around (cx,cy)
      // within a circular radius. Writes flat mean-color tiles to dstImage.
      function applyQuadtree(dstImage, cx, cy, radius) {
        const sw = sourceW, sh = sourceH;
        const sd = sourceData.data;
        const dd = dstImage.data;
        const dw = dstImage.width;
        const r2 = radius * radius;

        const bx0 = Math.max(0, Math.floor(cx - radius));
        const by0 = Math.max(0, Math.floor(cy - radius));
        const bx1 = Math.min(sw, Math.ceil(cx + radius));
        const by1 = Math.min(sh, Math.ceil(cy + radius));

        // Snap to a global grid so neighboring hover frames tile cleanly
        const gx0 = Math.floor(bx0 / CELL) * CELL;
        const gy0 = Math.floor(by0 / CELL) * CELL;

        function processTile(x, y, size) {
          x = Math.round(x);
          y = Math.round(y);
          size = Math.max(1, Math.round(size));
          const xs = Math.max(x, 0);
          const ys = Math.max(y, 0);
          const xe = Math.min(x + size, sw);
          const ye = Math.min(y + size, sh);
          if (xe <= xs || ye <= ys) return;

          let sumR = 0, sumG = 0, sumB = 0;
          let sumR2 = 0, sumG2 = 0, sumB2 = 0;
          let n = 0;
          const step = size > 16 ? 2 : 1;
          for (let yy = ys; yy < ye; yy += step) {
            let idx = (yy * sw + xs) * 4;
            for (let xx = xs; xx < xe; xx += step) {
              const r = sd[idx], g = sd[idx + 1], b = sd[idx + 2];
              sumR += r; sumG += g; sumB += b;
              sumR2 += r * r; sumG2 += g * g; sumB2 += b * b;
              n++;
              idx += 4 * step;
            }
          }
          if (!n) return;
          const mR = sumR / n, mG = sumG / n, mB = sumB / n;
          const variance =
            (sumR2 / n - mR * mR) +
            (sumG2 / n - mG * mG) +
            (sumB2 / n - mB * mB);

          if (variance > VARIANCE_THRESH && size > MIN_TILE * 2) {
            const half = size / 2;
            processTile(x,        y,        half);
            processTile(x + half, y,        half);
            processTile(x,        y + half, half);
            processTile(x + half, y + half, half);
            return;
          }

          const fR = mR | 0, fG = mG | 0, fB = mB | 0;
          for (let yy = ys; yy < ye; yy++) {
            const dyp = yy + 0.5 - cy;
            let didx = (yy * dw + xs) * 4;
            for (let xx = xs; xx < xe; xx++) {
              const dxp = xx + 0.5 - cx;
              if (dxp * dxp + dyp * dyp <= r2) {
                dd[didx]     = fR;
                dd[didx + 1] = fG;
                dd[didx + 2] = fB;
                dd[didx + 3] = 255;
              }
              didx += 4;
            }
          }
        }

        for (let gy = gy0; gy < by1; gy += CELL) {
          for (let gx = gx0; gx < bx1; gx += CELL) {
            const ccx = gx + CELL / 2, ccy = gy + CELL / 2;
            const dxp = ccx - cx, dyp = ccy - cy;
            if (dxp * dxp + dyp * dyp > (radius + CELL) * (radius + CELL)) continue;
            processTile(gx, gy, CELL);
          }
        }
      }

      function draw() {
        if (!sourceData) return;
        const rect = canvas.getBoundingClientRect();
        // Work in image-native coordinates on an offscreen buffer, then blit to display
        const buffer = new ImageData(
          new Uint8ClampedArray(sourceData.data),
          sourceW,
          sourceH
        );
        if (state.current.influence > 0.01) {
          const radius =
            Math.min(sourceW, sourceH) * BRUSH_RADIUS_FRAC * state.current.influence;
          const bcx = state.current.x * sourceW;
          const bcy = state.current.y * sourceH;
          applyQuadtree(buffer, bcx, bcy, radius);
        }

        // Render buffer to display canvas (scaled to rect)
        // Use a temporary canvas to avoid scaling putImageData (which ignores transforms)
        if (!draw._tmp || draw._tmp.width !== sourceW) {
          draw._tmp = document.createElement("canvas");
          draw._tmp.width = sourceW;
          draw._tmp.height = sourceH;
        }
        const tctx = draw._tmp.getContext("2d");
        tctx.putImageData(buffer, 0, 0);
        ctx.clearRect(0, 0, rect.width, rect.height);
        ctx.drawImage(draw._tmp, 0, 0, rect.width, rect.height);
      }

      function tick() {
        const ease = 0.22;
        state.current.x += (state.target.x - state.current.x) * ease;
        state.current.y += (state.target.y - state.current.y) * ease;
        state.current.influence += (state.target.influence - state.current.influence) * ease;

        draw();

        const settled =
          Math.abs(state.target.x - state.current.x) < 0.001 &&
          Math.abs(state.target.y - state.current.y) < 0.001 &&
          Math.abs(state.target.influence - state.current.influence) < 0.001;

        if (settled && state.target.influence < 0.01) {
          state.running = false;
          return;
        }
        requestAnimationFrame(tick);
      }

      function kick() {
        if (!state.running) {
          state.running = true;
          requestAnimationFrame(tick);
        }
      }

      function onMove(e) {
        const rect = canvas.getBoundingClientRect();
        state.target.x = (e.clientX - rect.left) / rect.width;
        state.target.y = (e.clientY - rect.top) / rect.height;
        state.target.influence = 1;
        kick();
      }

      function onLeave() {
        state.target.influence = 0;
        kick();
      }

      img.addEventListener("load", () => {
        // Cap long edge at 1400 for perf
        const MAX = 1400;
        const scale = Math.min(1, MAX / Math.max(img.naturalWidth, img.naturalHeight));
        sourceW = Math.max(1, Math.round(img.naturalWidth * scale));
        sourceH = Math.max(1, Math.round(img.naturalHeight * scale));
        const off = document.createElement("canvas");
        off.width = sourceW;
        off.height = sourceH;
        const octx = off.getContext("2d");
        octx.drawImage(img, 0, 0, sourceW, sourceH);
        try {
          sourceData = octx.getImageData(0, 0, sourceW, sourceH);
        } catch (err) {
          // Tainted canvas (file:// CORS) — fall back to drawing image without pixelation
          sourceData = null;
        }
        canvas.classList.add("loaded");
        resize();
        if (!sourceData) {
          // Draw image directly as fallback
          const rect = canvas.getBoundingClientRect();
          ctx.clearRect(0, 0, rect.width, rect.height);
          ctx.drawImage(img, 0, 0, rect.width, rect.height);
        }
      });
      img.addEventListener("error", () => {
        // leave fallback visible
      });
      img.src = srcUrl;

      canvas.addEventListener("mousemove", onMove);
      canvas.addEventListener("mouseleave", onLeave);
      window.addEventListener("resize", resize);
    });
  }

  // ============================================
  // PARALLAX — multi-layer scroll-driven transforms
  // ============================================
  function initParallax() {
    const items = [...document.querySelectorAll("[data-parallax]")].map((el) => ({
      el,
      speed: parseFloat(el.dataset.parallax) || 0.2,
      anchor: el.closest("section") || document.body,
    }));

    if (items.length === 0) return;

    let ticking = false;
    const viewportH = () => window.innerHeight;

    function update() {
      ticking = false;
      const vh = viewportH();
      items.forEach(({ el, speed, anchor }) => {
        const rect = anchor.getBoundingClientRect();
        // distance from viewport center to section center
        const sectionCenter = rect.top + rect.height / 2;
        const offset = (sectionCenter - vh / 2) * -speed;
        el.style.transform = `translate3d(0, ${offset.toFixed(1)}px, 0)`;
      });
    }

    function onScroll() {
      if (!ticking) {
        requestAnimationFrame(update);
        ticking = true;
      }
    }

    window.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("resize", onScroll);
    update();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
