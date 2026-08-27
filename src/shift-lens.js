/**
 * Shift-held magnifier lens for the graph view.
 *
 * Live DOM cannot be sampled like a texture, so the lens renders the scene a
 * second time: nodes intersecting the lens are cloned into a miniature copy
 * of the surface, visualiser canvases are blitted from their sources on the
 * mirror cadence, and the sky is blitted from the background canvas. The
 * optics are layered on top of that copy:
 *
 * - Lateral chromatic aberration is reproduced by its actual mechanism: two
 *   extra channel-isolated copies of the content are rendered at slightly
 *   different magnifications, anchored at the lens centre, so the channel
 *   separation is zero in the middle and grows towards the rim.
 * - Field softness at the rim comes from a radially masked backdrop blur.
 * - The glass itself (specular highlights, vignette, glass-edge tint) is a
 *   gradient overlay above the clip.
 */

const LENS_DIAMETER = 264;
const LENS_ZOOM = 2.25;
const CA_DELTA = 0.008;
const BLIT_INTERVAL = 48;
const MEMBER_MARGIN = 24;

let lensSequence = 0;

/**
 * Transform that puts the surface point under the pointer at the lens centre.
 * channelScale is the per-colour-channel magnification factor used by the
 * chromatic-aberration copies; the anchoring keeps aberration zero at centre.
 */
export function lensWorldTransform({ pointerX, pointerY, camera, radius, zoom, channelScale = 1 }) {
  const worldX = (pointerX - camera.x) / camera.scale;
  const worldY = (pointerY - camera.y) / camera.scale;
  const scale = camera.scale * zoom * channelScale;
  return {
    translateX: radius - worldX * scale,
    translateY: radius - worldY * scale,
    scale,
  };
}

/**
 * Source/destination rectangles for blitting a square region centred on
 * (centerX, centerY) out of a canvas, clamped to the canvas bounds with the
 * destination shrunk to match. Returns null when nothing overlaps.
 */
export function clampedSampleRect({ centerX, centerY, half, sourceWidth, sourceHeight, targetSize }) {
  const size = half * 2;
  if (size <= 0 || sourceWidth <= 0 || sourceHeight <= 0) return null;
  const left = centerX - half;
  const top = centerY - half;
  const sx = Math.max(0, left);
  const sy = Math.max(0, top);
  const sx1 = Math.min(sourceWidth, left + size);
  const sy1 = Math.min(sourceHeight, top + size);
  if (sx1 <= sx || sy1 <= sy) return null;
  const ratio = targetSize / size;
  return {
    sx,
    sy,
    sw: sx1 - sx,
    sh: sy1 - sy,
    dx: (sx - left) * ratio,
    dy: (sy - top) * ratio,
    dw: (sx1 - sx) * ratio,
    dh: (sy1 - sy) * ratio,
  };
}

export function createShiftLens({
  viewport,
  surface,
  nodeLayer,
  edgeLayer,
  backgroundCanvas,
  getCamera,
  isSuppressed,
}) {
  const suffix = ++lensSequence;
  const radius = LENS_DIAMETER / 2;
  const root = document.createElement('div');
  root.className = 'graph-lens';
  root.hidden = true;
  root.setAttribute('aria-hidden', 'true');
  root.innerHTML = `
    <svg class="graph-lens-defs" width="0" height="0" aria-hidden="true">
      <defs>
        <filter id="graph-lens-red-${suffix}" color-interpolation-filters="sRGB">
          <feColorMatrix type="matrix" values="1 0 0 0 0  0 0 0 0 0  0 0 0 0 0  0 0 0 1 0" />
        </filter>
        <filter id="graph-lens-blue-${suffix}" color-interpolation-filters="sRGB">
          <feColorMatrix type="matrix" values="0 0 0 0 0  0 0 0 0 0  0 0 1 0 0  0 0 0 1 0" />
        </filter>
      </defs>
    </svg>
    <div class="graph-lens-clip">
      <canvas class="graph-lens-bg" aria-hidden="true"></canvas>
      <div class="graph-lens-world graph-lens-world-main"></div>
      <div class="graph-lens-ca graph-lens-ca-red"><div class="graph-lens-world"></div></div>
      <div class="graph-lens-ca graph-lens-ca-blue"><div class="graph-lens-world"></div></div>
      <div class="graph-lens-blur"></div>
    </div>
    <div class="graph-lens-glass"></div>
  `;
  const bgCanvas = root.querySelector('.graph-lens-bg');
  const worldMain = root.querySelector('.graph-lens-world-main');
  const caRed = root.querySelector('.graph-lens-ca-red');
  const caBlue = root.querySelector('.graph-lens-ca-blue');
  const worldRed = caRed.querySelector('.graph-lens-world');
  const worldBlue = caBlue.querySelector('.graph-lens-world');
  caRed.style.filter = `url(#graph-lens-red-${suffix})`;
  caBlue.style.filter = `url(#graph-lens-blue-${suffix})`;
  const bgPixelRatio = Math.min(devicePixelRatio || 1, 1.5);
  bgCanvas.width = Math.max(1, Math.round(LENS_DIAMETER * bgPixelRatio));
  bgCanvas.height = bgCanvas.width;
  viewport.append(root);

  let destroyed = false;
  let visible = false;
  let shiftHeld = false;
  let pointerInside = false;
  let clientX = 0;
  let clientY = 0;
  let viewportRect = null;
  let frameId = 0;
  let lastBlit = -Infinity;
  let contentDirty = true;
  let membershipKey = '';
  let canvasPairs = [];

  const observer = new MutationObserver(() => {
    contentDirty = true;
  });

  function updatePointer(event) {
    clientX = event.clientX;
    clientY = event.clientY;
  }

  function pointerEntered(event) {
    pointerInside = true;
    updatePointer(event);
    maybeShow();
  }

  function pointerLeft() {
    pointerInside = false;
    hide();
  }

  function onKeyDown(event) {
    if (event.key !== 'Shift' || event.repeat) return;
    if (event.ctrlKey || event.metaKey || event.altKey) return;
    shiftHeld = true;
    maybeShow();
  }

  function onKeyUp(event) {
    if (event.key !== 'Shift') return;
    shiftHeld = false;
    hide();
  }

  function releaseShift() {
    shiftHeld = false;
    hide();
  }

  function pointerOverViewport() {
    const target = document.elementFromPoint(clientX, clientY);
    return Boolean(target && viewport.contains(target));
  }

  function maybeShow() {
    if (destroyed || visible || !shiftHeld || !pointerInside) return;
    if (isSuppressed() || !pointerOverViewport()) return;
    visible = true;
    viewportRect = viewport.getBoundingClientRect();
    root.hidden = false;
    viewport.classList.add('is-lens-active');
    observer.observe(nodeLayer, { subtree: true, childList: true, attributes: true, characterData: true });
    observer.observe(edgeLayer, { subtree: true, childList: true, attributes: true });
    contentDirty = true;
    membershipKey = '';
    lastBlit = -Infinity;
    frameId = requestAnimationFrame(frame);
  }

  function hide() {
    if (!visible) return;
    visible = false;
    cancelAnimationFrame(frameId);
    frameId = 0;
    observer.disconnect();
    root.hidden = true;
    viewport.classList.remove('is-lens-active');
    worldMain.replaceChildren();
    worldRed.replaceChildren();
    worldBlue.replaceChildren();
    canvasPairs = [];
    membershipKey = '';
  }

  function membersUnderLens(camera) {
    const worldRadius = radius / (camera.scale * LENS_ZOOM) + MEMBER_MARGIN;
    const worldX = ((clientX - viewportRect.left) - camera.x) / camera.scale;
    const worldY = ((clientY - viewportRect.top) - camera.y) / camera.scale;
    const members = [];
    for (const element of nodeLayer.children) {
      if (element.offsetLeft + element.offsetWidth < worldX - worldRadius) continue;
      if (element.offsetLeft > worldX + worldRadius) continue;
      if (element.offsetTop + element.offsetHeight < worldY - worldRadius) continue;
      if (element.offsetTop > worldY + worldRadius) continue;
      members.push(element);
    }
    return members;
  }

  function cloneWorldContent(members, includeEdges) {
    const fragment = document.createDocumentFragment();
    if (includeEdges) fragment.append(edgeLayer.cloneNode(true));
    for (const member of members) {
      const clone = member.cloneNode(true);
      // Widget canvases carry document ids; the clones must never win a
      // getElementById lookup against the originals.
      for (const owned of clone.querySelectorAll('[id]')) owned.removeAttribute('id');
      clone.removeAttribute('id');
      fragment.append(clone);
    }
    return fragment;
  }

  function rebuildContent(members) {
    for (const world of [worldMain, worldRed, worldBlue]) {
      world.style.width = surface.style.width;
      world.style.height = surface.style.height;
    }
    worldMain.replaceChildren(cloneWorldContent(members, true));
    // The aberration copies show only near the rim; edges are skipped there
    // to keep the rebuild at three node clones, not three edge-layer clones.
    worldRed.replaceChildren(cloneWorldContent(members, false));
    worldBlue.replaceChildren(cloneWorldContent(members, false));
    canvasPairs = [];
    for (const world of [worldMain, worldRed, worldBlue]) {
      const targets = world.querySelectorAll('.graph-node canvas');
      let index = 0;
      for (const member of members) {
        for (const source of member.querySelectorAll('canvas')) {
          const target = targets[index];
          index += 1;
          if (target) canvasPairs.push({ source, target });
        }
      }
    }
    contentDirty = false;
  }

  function blitCanvases() {
    for (const { source, target } of canvasPairs) {
      if (!source.isConnected || source.width <= 1 || source.height <= 1) continue;
      if (target.width !== source.width || target.height !== source.height) {
        target.width = source.width;
        target.height = source.height;
      }
      const context = target.getContext('2d');
      context.clearRect(0, 0, target.width, target.height);
      context.drawImage(source, 0, 0);
    }
  }

  function blitBackground(pointerX, pointerY) {
    const context = bgCanvas.getContext('2d');
    context.fillStyle = '#0a0e15';
    context.fillRect(0, 0, bgCanvas.width, bgCanvas.height);
    if (!backgroundCanvas || backgroundCanvas.hidden || backgroundCanvas.width <= 1) return;
    const sourceRatio = backgroundCanvas.width / Math.max(1, viewport.clientWidth);
    const rect = clampedSampleRect({
      centerX: pointerX * sourceRatio,
      centerY: pointerY * sourceRatio,
      half: (radius / LENS_ZOOM) * sourceRatio,
      sourceWidth: backgroundCanvas.width,
      sourceHeight: backgroundCanvas.height,
      targetSize: bgCanvas.width,
    });
    if (!rect) return;
    context.drawImage(backgroundCanvas, rect.sx, rect.sy, rect.sw, rect.sh, rect.dx, rect.dy, rect.dw, rect.dh);
  }

  function applyWorldTransform(world, transform) {
    world.style.transform =
      `translate(${transform.translateX}px, ${transform.translateY}px) scale(${transform.scale})`;
  }

  function frame(now) {
    frameId = 0;
    if (!visible) return;
    if (isSuppressed()) {
      hide();
      return;
    }
    frameId = requestAnimationFrame(frame);
    const pointerX = clientX - viewportRect.left;
    const pointerY = clientY - viewportRect.top;
    root.style.transform = `translate(${pointerX - radius}px, ${pointerY - radius}px)`;
    const camera = getCamera();
    const members = membersUnderLens(camera);
    const nextKey = members.map((element) => element.dataset.nodeId || '').join('|');
    if (nextKey !== membershipKey) {
      membershipKey = nextKey;
      contentDirty = true;
    }
    if (contentDirty) rebuildContent(members);
    const base = { pointerX, pointerY, camera, radius, zoom: LENS_ZOOM };
    applyWorldTransform(worldMain, lensWorldTransform(base));
    applyWorldTransform(worldRed, lensWorldTransform({ ...base, channelScale: 1 + CA_DELTA }));
    applyWorldTransform(worldBlue, lensWorldTransform({ ...base, channelScale: 1 - CA_DELTA }));
    // The sky sample tracks the pointer, so it must refresh every frame or
    // the clouds step while the lens glides. Visualiser sources only update
    // on the mirror cadence, so their blits stay throttled.
    blitBackground(pointerX, pointerY);
    if (now - lastBlit >= BLIT_INTERVAL) {
      lastBlit = now;
      blitCanvases();
    }
  }

  viewport.addEventListener('pointermove', updatePointer);
  viewport.addEventListener('pointerenter', pointerEntered);
  viewport.addEventListener('pointerleave', pointerLeft);
  window.addEventListener('keydown', onKeyDown);
  window.addEventListener('keyup', onKeyUp);
  window.addEventListener('blur', releaseShift);
  document.addEventListener('visibilitychange', releaseShift);

  return {
    hide,
    destroy() {
      destroyed = true;
      hide();
      observer.disconnect();
      viewport.removeEventListener('pointermove', updatePointer);
      viewport.removeEventListener('pointerenter', pointerEntered);
      viewport.removeEventListener('pointerleave', pointerLeft);
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
      window.removeEventListener('blur', releaseShift);
      document.removeEventListener('visibilitychange', releaseShift);
      root.remove();
    },
  };
}
