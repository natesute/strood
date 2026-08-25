const { test, expect } = require('@playwright/test');
const AxeBuilder = require('@axe-core/playwright').default;
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');

test('exposes the core live-coding workflow without hidden shortcuts', async ({ page }) => {
  await page.goto('/');
  await expect(page).toHaveTitle('Strood');
  await expect(page.getByRole('button', { name: 'Play', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Stop', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Stop', exact: true })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Update', exact: true })).toHaveCount(0);
  await expect(page.locator('#save-state')).toBeHidden();
  await expect(page.locator('#info, #cycle-status, #section-status, #statusline .sep')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Open' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Patch' })).toBeVisible();
  const editor = page.getByRole('textbox', { name: 'Song code' });
  await expect(editor).toBeVisible();
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await editor.click();
  await expect.poll(() => page.locator('.cm-cursorLayer').evaluate((layer) =>
    getComputedStyle(layer).animationDuration)).toBe('1.2s');
  await expect(page.locator('#track-region')).toHaveCount(0);
  await expect(page.getByRole('button', { name: /Solo track/ })).toBeVisible();
  await expect(page.locator('.cm-smart-number[data-smart-name="cycles"]')).toHaveCount(0);
  await expect(editor).not.toContainText('const arrangement');
  await expect(editor).toContainText('const track');
  await expect(editor).toContainText('const vocalNotes');
  await expect(editor).toContainText('const leadVocal');
  await expect(page.locator('.cm-method-help[data-method-help="lpf"]').first())
    .toHaveAttribute('title', 'Remove frequencies above this cutoff.');
  await expect.poll(() => page.evaluate(() =>
    (localStorage.getItem('strudel_code')?.match(/mute: false/g) || []).length)).toBe(8);
});

test('offers a source-backed graph as an alternative editor view', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Graph' }).click();

  const graph = page.getByRole('region', { name: 'Song graph' });
  await expect(graph).toBeVisible();
  await expect(page.getByRole('textbox', { name: 'Song code', exact: true })).toBeHidden();
  await expect(graph.locator('.graph-declaration-node').first()).toBeVisible();
  await expect(graph.locator('.graph-declaration-node .graph-source-wrap').first()).toBeVisible();
  await expect(graph.locator('.graph-declaration-node').first()).toHaveCSS('height', '140px');
  await expect(graph.locator('.graph-track-node').first().getByRole('textbox')).toBeVisible();
  await expect(graph.locator('.graph-notes-node').first()).toBeVisible();
  await expect(graph.locator('.graph-visualizer-node').first()).toBeVisible();
  await expect(graph.locator('.graph-toolbar, .graph-fit-all, .graph-actual-size, .graph-arrange'))
    .toHaveCount(0);
  expect(await graph.locator('.graph-viewport').evaluate((viewport) => {
    const surface = viewport.querySelector('.graph-surface').getBoundingClientRect();
    const frame = viewport.getBoundingClientRect();
    return surface.width <= frame.width + 1 && surface.height <= frame.height + 1;
  })).toBe(true);
  expect(await graph.evaluate((root) => {
    const nodes = [...root.querySelectorAll('.graph-node[data-node-id]')].map((node) => ({
      id: node.dataset.nodeId,
      left: node.offsetLeft,
      right: node.offsetLeft + node.offsetWidth,
      top: node.offsetTop,
      bottom: node.offsetTop + node.offsetHeight,
    }));
    const crosses = (from, to, rect) => {
      if (from.y === to.y) {
        return from.y > rect.top && from.y < rect.bottom
          && Math.max(Math.min(from.x, to.x), rect.left) < Math.min(Math.max(from.x, to.x), rect.right);
      }
      return from.x > rect.left && from.x < rect.right
        && Math.max(Math.min(from.y, to.y), rect.top) < Math.min(Math.max(from.y, to.y), rect.bottom);
    };
    return [...root.querySelectorAll('.graph-edge[data-edge-id]')].every((edge) => {
      const path = edge.getAttribute('d');
      if (!/^(?:[ML]\s*-?[\d.]+\s*-?[\d.]+\s*)+$/i.test(path)) return false;
      const commands = [...path.matchAll(/([ML])\s*(-?[\d.]+)\s*(-?[\d.]+)/g)];
      const points = commands.map((match) => ({ x: Number(match[2]), y: Number(match[3]) }));
      for (let index = 1; index < points.length; index++) {
        const from = points[index - 1];
        const to = points[index];
        if (from.x !== to.x && from.y !== to.y) return false;
        if (nodes.some((node) => node.id !== edge.dataset.from
          && node.id !== edge.dataset.to && crosses(from, to, node))) return false;
      }
      return true;
    });
  })).toBe(true);

  const liveState = await graph.evaluate(async (root) => {
    const noteNode = root.querySelector('.graph-notes-node');
    const noteTokens = [...noteNode.querySelectorAll('.graph-source-token')];
    const token = noteTokens[0];
    const neighbouringTokens = noteTokens.slice(1, 5);
    const visualizerNode = root.querySelector('.graph-visualizer-node');
    const stableStyle = (element) => {
      const style = getComputedStyle(element);
      return [style.borderColor, style.backgroundColor, style.boxShadow];
    };
    const noteStyleBefore = stableStyle(noteNode);
    const visualizerStyleBefore = stableStyle(visualizerNode);
    const edge = root.querySelector('.graph-edge[data-edge-id]');
    const edgeStyleBefore = stableStyle(edge);
    const textColorBefore = getComputedStyle(token).color;
    const neighbourLayoutBefore = neighbouringTokens.map((element) => {
      const rect = element.getBoundingClientRect();
      return [rect.x, rect.y, rect.width, rect.height];
    });
    const [from, to] = token.dataset.range.split(':').map(Number);
    document.dispatchEvent(new CustomEvent('strood:note-activity', {
      detail: { activations: [{ from, to, label: token.textContent, color: '#ff8844', onset: true }] },
    }));
    const tokenActive = token.classList.contains('is-active-note');
    const onset = token.classList.contains('is-note-onset');
    const onsetTextUnchanged = getComputedStyle(token).color === textColorBefore;
    const activationColor = getComputedStyle(token).getPropertyValue('--note-activation-color');
    const notes = Boolean(token.closest('.graph-node')?.classList.contains('is-sounding'));
    const visualizer = Boolean(root.querySelector('.graph-visualizer-node.is-sounding'));
    document.dispatchEvent(new CustomEvent('strood:note-activity', {
      detail: { activations: [] },
    }));
    const retainedAfterEmptyFrame = token.classList.contains('is-active-note');
    await new Promise((resolve) => setTimeout(resolve, 55));
    const sustainedOnset = token.classList.contains('is-note-onset');
    const sustainedHighlight = token.classList.contains('is-active-note');
    const sustainedTextUnchanged = getComputedStyle(token).color === textColorBefore;
    const tokenBounds = token.getBoundingClientRect();
    const sourceBounds = token.closest('.graph-source-wrap').getBoundingClientRect();
    await new Promise((resolve) => setTimeout(resolve, 140));
    return {
      token: tokenActive,
      onset,
      onsetTextUnchanged,
      retainedAfterEmptyFrame,
      sustainedOnset,
      sustainedHighlight,
      sustainedTextUnchanged,
      staccatoExpired: !token.classList.contains('is-active-note'),
      activationColor,
      notes,
      visualizer,
      visible: tokenBounds.top >= sourceBounds.top - 1
        && tokenBounds.bottom <= sourceBounds.bottom + 1
        && tokenBounds.left >= sourceBounds.left - 1
        && tokenBounds.right <= sourceBounds.right + 1,
      readable: tokenBounds.height >= 8,
      stableNode: JSON.stringify(noteStyleBefore) === JSON.stringify(stableStyle(noteNode)),
      stableVisualizer: JSON.stringify(visualizerStyleBefore) === JSON.stringify(stableStyle(visualizerNode)),
      stableEdge: JSON.stringify(edgeStyleBefore) === JSON.stringify(stableStyle(edge)),
      stableTextLayout: JSON.stringify(neighbourLayoutBefore) === JSON.stringify(
        neighbouringTokens.map((element) => {
          const rect = element.getBoundingClientRect();
          return [rect.x, rect.y, rect.width, rect.height];
        }),
      ),
      highlightedEdges: root.querySelectorAll('.graph-edge.is-active').length,
      subheading: Boolean(noteNode.querySelector('.graph-node-kind')),
      stripe: getComputedStyle(noteNode, '::before').content === 'none',
      fontSize: getComputedStyle(noteNode.querySelector('.graph-source-render')).fontSize,
      outputPorts: root.querySelectorAll('.graph-output-port').length,
      hiddenPorts: [...root.querySelectorAll('.graph-port')].every((port) => {
        const style = getComputedStyle(port);
        return style.opacity === '0' && style.borderStyle === 'none';
      }),
    };
  });
  expect(liveState).toEqual({
    token: true,
    onset: true,
    onsetTextUnchanged: true,
    retainedAfterEmptyFrame: true,
    sustainedOnset: false,
    sustainedHighlight: true,
    sustainedTextUnchanged: true,
    staccatoExpired: true,
    activationColor: '#ff8844',
    notes: true,
    visualizer: true,
    visible: true,
    readable: true,
    stableNode: true,
    stableVisualizer: true,
    stableEdge: true,
    stableTextLayout: true,
    highlightedEdges: 0,
    subheading: false,
    stripe: true,
    fontSize: '12px',
    outputPorts: 0,
    hiddenPorts: true,
  });

  const autoFollowTarget = await graph.evaluate((root) => {
    const node = [...root.querySelectorAll('.graph-notes-node')]
      .sort((left, right) => right.querySelectorAll('.graph-source-token').length
        - left.querySelectorAll('.graph-source-token').length)[0];
    if (!node) return null;
    node.style.minWidth = '0';
    node.style.minHeight = '0';
    node.style.width = '180px';
    node.style.height = '80px';
    const wrapper = node.querySelector('.graph-source-wrap');
    const token = [...node.querySelectorAll('.graph-source-token')]
      .sort((left, right) => right.offsetTop - left.offsetTop)[0];
    if (!wrapper || !token || wrapper.scrollHeight <= wrapper.clientHeight + 4) return null;
    const [from, to] = token.dataset.range.split(':').map(Number);
    return { nodeId: node.dataset.nodeId, from, to, label: token.textContent };
  });
  expect(autoFollowTarget).not.toBeNull();
  const followedNode = graph.locator(`[data-node-id="${autoFollowTarget.nodeId}"]`);
  const followedWrapper = followedNode.locator('.graph-source-wrap');
  await followedWrapper.evaluate((wrapper) => { wrapper.scrollTop = 0; });
  await followedNode.hover();
  await page.evaluate((activation) => {
    document.dispatchEvent(new CustomEvent('strood:note-activity', {
      detail: { activations: [{ ...activation, color: '#56d4dd', onset: true }] },
    }));
  }, autoFollowTarget);
  await page.waitForTimeout(50);
  expect(await followedWrapper.evaluate((wrapper) => wrapper.scrollTop)).toBe(0);

  await graph.locator('.graph-performance').hover();
  await page.evaluate((activation) => {
    document.dispatchEvent(new CustomEvent('strood:note-activity', {
      detail: { activations: [{ ...activation, color: '#56d4dd', onset: true }] },
    }));
  }, autoFollowTarget);
  await expect.poll(() => followedWrapper.evaluate((wrapper) => wrapper.scrollTop))
    .toBeGreaterThan(0);

  const declaration = graph.locator('.graph-declaration-node').first();
  const sourceName = await declaration.getAttribute('data-source-name');
  const visualizersBefore = await graph.locator('.graph-visualizer-node').count();
  const visualizerPositionsBefore = await graph.locator('.graph-visualizer-node').evaluateAll((nodes) =>
    Object.fromEntries(nodes.map((node) => [node.dataset.nodeId, [node.offsetLeft, node.offsetTop]])));
  await declaration.hover();
  const addVisualizerButton = declaration.getByRole('button', {
    name: `Add visualiser to ${sourceName}`,
  });
  await expect(addVisualizerButton).toHaveCSS('opacity', '1');
  const addButtonHitState = await addVisualizerButton.evaluate((button) => {
    const rect = button.getBoundingClientRect();
    const parentRect = button.closest('.graph-node').getBoundingClientRect();
    const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
    return {
      hit: hit?.tagName || null,
      hitWithinButton: button.contains(hit),
      pointerEvents: getComputedStyle(button).pointerEvents,
      width: Math.round(rect.width * 100) / 100,
      height: Math.round(rect.height * 100) / 100,
      insideParent: rect.left >= parentRect.left && rect.right <= parentRect.right
        && rect.top >= parentRect.top && rect.bottom <= parentRect.bottom,
      scale: document.querySelector('#graph-view').dataset.graphScale,
    };
  });
  expect(addButtonHitState.hitWithinButton, JSON.stringify(addButtonHitState)).toBe(true);
  await addVisualizerButton.click();
  await graph.getByRole('menuitem', { name: 'Cymatics' }).click();
  await expect(graph.locator('.graph-visualizer-node')).toHaveCount(visualizersBefore + 1);
  await expect.poll(() => page.evaluate(({ sourceName }) => {
    const source = localStorage.getItem('strudel_code') || '';
    const start = source.indexOf(`const ${sourceName}`);
    const next = source.indexOf('\nconst ', start + 1);
    return source.slice(start, next === -1 ? source.length : next).includes('._cymatics');
  }, { sourceName })).toBe(true);
  expect(await graph.locator('.graph-visualizer-node').evaluateAll((nodes, previous) =>
    nodes.every((node) => !previous[node.dataset.nodeId]
      || JSON.stringify(previous[node.dataset.nodeId]) === JSON.stringify([node.offsetLeft, node.offsetTop])),
  visualizerPositionsBefore)).toBe(true);

  const addedVisualizer = graph.getByRole('button', { name: 'Delete cymatics visualiser' });
  await expect(addedVisualizer).toBeVisible();
  await addedVisualizer.click();
  await expect(graph.locator('.graph-visualizer-node')).toHaveCount(visualizersBefore);
  await expect.poll(() => page.evaluate(({ sourceName }) => {
    const source = localStorage.getItem('strudel_code') || '';
    const start = source.indexOf(`const ${sourceName}`);
    const next = source.indexOf('\nconst ', start + 1);
    return source.slice(start, next === -1 ? source.length : next).includes('._cymatics');
  }, { sourceName })).toBe(false);

  const before = await declaration.boundingBox();
  const handle = declaration.locator('.graph-node-header');
  const handleBox = await handle.boundingBox();
  await page.mouse.move(handleBox.x + 35, handleBox.y + 15);
  await page.mouse.down();
  await page.mouse.move(handleBox.x + 79, handleBox.y + 47, { steps: 4 });
  await page.mouse.up();
  const after = await declaration.boundingBox();
  expect(after.x).toBeGreaterThan(before.x + 30);
  expect(after.y).toBeGreaterThan(before.y + 20);
  await expect.poll(() => page.evaluate(({ sourceName }) => {
    const song = localStorage.getItem('strudel_song_name') || 'Untitled';
    const key = `strood:graph-layout:v9:${encodeURIComponent(song)}`;
    return JSON.parse(localStorage.getItem(key) || '{}')[sourceName]?.x || 0;
  }, { sourceName })).toBeGreaterThan(0);

  const zoomState = await graph.locator('.graph-viewport').evaluate(async (viewport) => {
    const graph = viewport.closest('#graph-view');
    const transport = document.querySelector('#transport');
    const frameBefore = viewport.getBoundingClientRect();
    const transportBefore = transport.getBoundingClientRect();
    const scaleBefore = Number(graph.dataset.graphScale);
    const clientX = frameBefore.left + frameBefore.width * .68;
    const clientY = frameBefore.top + frameBefore.height * .56;
    let scaleMutations = 0;
    let stageLayoutMutations = 0;
    let surfaceTransformMutations = 0;
    const observer = new MutationObserver((records) => {
      scaleMutations += records.filter(({ attributeName }) => attributeName === 'data-graph-scale').length;
      stageLayoutMutations += records.filter(({ target, attributeName }) =>
        target.classList?.contains('graph-stage') && attributeName === 'style').length;
      surfaceTransformMutations += records.filter(({ target, attributeName }) =>
        target.classList?.contains('graph-surface') && attributeName === 'style').length;
    });
    observer.observe(graph, { attributes: true, subtree: true });
    const accepted = Array.from({ length: 20 }, () => viewport.dispatchEvent(new WheelEvent('wheel', {
      bubbles: true,
      cancelable: true,
      ctrlKey: true,
      clientX,
      clientY,
      deltaY: -3.5,
    }))).every(Boolean);
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    observer.disconnect();
    const frameAfter = viewport.getBoundingClientRect();
    const transportAfter = transport.getBoundingClientRect();
    return {
      prevented: !accepted,
      scaleBefore,
      scaleAfter: Number(graph.dataset.graphScale),
      scaleMutations,
      stageLayoutMutations,
      surfaceTransformMutations,
      frameStable: frameBefore.top === frameAfter.top && frameBefore.height === frameAfter.height,
      transportStable: transportBefore.top === transportAfter.top
        && transportBefore.height === transportAfter.height,
      pageStayedPut: window.scrollY === 0,
    };
  });
  expect(zoomState.prevented).toBe(true);
  expect(zoomState.scaleAfter).toBeGreaterThan(zoomState.scaleBefore);
  expect(zoomState.scaleMutations).toBe(1);
  expect(zoomState.stageLayoutMutations).toBe(0);
  expect(zoomState.surfaceTransformMutations).toBe(1);
  expect(zoomState.frameStable).toBe(true);
  expect(zoomState.transportStable).toBe(true);
  expect(zoomState.pageStayedPut).toBe(true);

  const viewport = graph.locator('.graph-viewport');
  const surface = graph.locator('.graph-surface');
  await expect.poll(() => viewport.evaluate((element) =>
    element.classList.contains('is-camera-moving'))).toBe(false);
  await expect(surface).toHaveCSS('will-change', 'auto');
  expect(await surface.evaluate((element) => element.style.transform)).toMatch(/^translate\(/);

  const panPoint = await viewport.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    for (let y = rect.bottom - 12; y > rect.top + 12; y -= 20) {
      for (let x = rect.left + 12; x < rect.right - 12; x += 20) {
        const target = document.elementFromPoint(x, y);
        if (target && element.contains(target) && !target.closest('.graph-node')) return { x, y };
      }
    }
    return null;
  });
  expect(panPoint).not.toBeNull();
  const transformBeforePan = await surface.evaluate((element) => element.style.transform);
  await page.mouse.move(panPoint.x, panPoint.y);
  await page.mouse.down();
  await page.mouse.move(panPoint.x + 72, panPoint.y + 44, { steps: 4 });
  await page.mouse.up();
  await expect.poll(() => surface.evaluate((element) => element.style.transform))
    .not.toBe(transformBeforePan);
  await expect.poll(() => viewport.evaluate((element) =>
    element.classList.contains('is-background-panning'))).toBe(false);

  await page.getByRole('button', { name: 'Code' }).click();
  await expect(page.getByRole('textbox', { name: 'Song code', exact: true })).toBeVisible();
  await expect(graph).toBeHidden();
});

test('places the caret on the first graph-source click and updates live playback', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Play', exact: true }).click();
  await page.getByRole('button', { name: 'Graph', exact: true }).click();

  const source = page.locator('.graph-notes-node .graph-source').first();
  await source.click({ position: { x: 110, y: 18 } });
  await expect(source).toBeFocused();
  expect(await source.evaluate((element) => element.selectionStart)).toBeGreaterThan(0);
  await expect.poll(() => page.locator(
    '.graph-source-wrap.is-editing .graph-source-token.is-active-note',
  ).count(), { timeout: 6000 }).toBeGreaterThan(0);
  await expect(source.locator('xpath=preceding-sibling::*[1]')).toHaveCSS('opacity', '1');

  await source.evaluate((element) => {
    const position = Math.max(0, element.value.length - 1);
    element.setSelectionRange(position, position);
  });
  await page.keyboard.type(' ');
  await expect.poll(() => source.evaluate((element) =>
    element.previousElementSibling?.textContent === element.value)).toBe(true);
  await expect.poll(() => page.locator(
    '.graph-source-wrap.is-editing .graph-source-token.is-active-note',
  ).count(), { timeout: 6000 }).toBeGreaterThan(0);
  await expect(page.getByRole('button', { name: 'Update', exact: true })).toBeVisible();
  await expect(page.locator('#mode')).toHaveText('PLAYING');
  expect(await page.evaluate(() => {
    const content = document.querySelector('.cm-content');
    const evaluated = document.querySelector('#editors-container')?.dataset.evaluatedLength;
    return content?.dataset.documentLength !== evaluated;
  })).toBe(true);

  await page.getByRole('button', { name: 'Update', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Update', exact: true })).toHaveCount(0);
  await expect.poll(() => page.evaluate(() => {
    const content = document.querySelector('.cm-content');
    const evaluated = document.querySelector('#editors-container')?.dataset.evaluatedLength;
    return content?.dataset.documentLength === evaluated;
  }), { timeout: 5000 }).toBe(true);
  await expect(page.locator('#mode')).toHaveText('PLAYING');
  await page.getByRole('button', { name: 'Stop', exact: true }).click();
});

test('packs a dense song graph across the available viewport', async ({ page }) => {
  const song = await fs.readFile(path.resolve(__dirname, '../../songs/kids - mgmt.strudel'), 'utf8');
  await page.addInitScript(({ code }) => {
    localStorage.setItem('strudel_code', code);
    localStorage.setItem('strudel_song_name', 'kids - mgmt');
    localStorage.setItem('strood:workspace-view', 'code');
    localStorage.setItem('strood:graph-layout:v7:kids%20-%20mgmt', JSON.stringify({
      vocals: { x: 9000, y: 9000, width: 164, height: 27 },
    }));
  }, { code: song });
  await page.goto('/');
  await page.getByRole('button', { name: 'Graph', exact: true }).click();

  const graph = page.getByRole('region', { name: 'Song graph' });
  const metrics = await graph.locator('.graph-viewport').evaluate((viewport) => {
    const surface = viewport.querySelector('.graph-surface');
    const frame = viewport.getBoundingClientRect();
    const rendered = surface.getBoundingClientRect();
    const nodes = [...viewport.querySelectorAll('.graph-node[data-node-id]')];
    const rectangles = nodes.map((node) => ({
      left: node.offsetLeft,
      right: node.offsetLeft + node.offsetWidth,
      top: node.offsetTop,
      bottom: node.offsetTop + node.offsetHeight,
    }));
    const overlapPairs = [];
    for (let left = 0; left < rectangles.length; left += 1) {
      for (let right = left + 1; right < rectangles.length; right += 1) {
        const a = rectangles[left];
        const b = rectangles[right];
        if (a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top) {
          overlapPairs.push([nodes[left].dataset.nodeId, nodes[right].dataset.nodeId]);
        }
      }
    }
    return {
      nodeCount: nodes.length,
      edgeCount: viewport.querySelectorAll('.graph-edge[data-edge-id]').length,
      scale: rendered.width / Number.parseFloat(surface.style.width),
      widthFill: rendered.width / frame.width,
      heightFill: rendered.height / frame.height,
      overlapPairs,
    };
  });

  expect(metrics).toEqual({
    nodeCount: 47,
    edgeCount: 41,
    scale: expect.any(Number),
    widthFill: expect.any(Number),
    heightFill: expect.any(Number),
    overlapPairs: [],
  });
  expect(metrics.scale).toBeGreaterThan(.35);
  expect(metrics.widthFill).toBeGreaterThan(.9);
  expect(metrics.heightFill).toBeGreaterThan(.8);
});

test('controls tracks, pause and section cues from the graph', async ({ page }) => {
  const song = await fs.readFile(path.resolve(__dirname, '../../songs/kids - mgmt.strudel'), 'utf8');
  await page.addInitScript(({ code }) => {
    localStorage.setItem('strudel_code', code);
    localStorage.setItem('strudel_song_name', 'kids - mgmt');
    localStorage.setItem('strood:workspace-view', 'graph');
  }, { code: song });
  await page.goto('/');

  const graph = page.getByRole('region', { name: 'Song graph' });
  const hook = graph.locator('[data-node-id="hookVoice"]');
  const mute = hook.locator('.graph-track-mute');
  const solo = hook.locator('.graph-track-solo');
  await expect(mute).toHaveAttribute('aria-pressed', 'false');
  await expect(solo).toHaveAttribute('aria-pressed', 'false');

  await mute.click();
  await expect(mute).toHaveAttribute('aria-pressed', 'true');
  await expect.poll(() => page.evaluate(() => localStorage.getItem('strudel_code')))
    .toContain('const hookMix = { gain: .82, pan: .48, mute: true }');
  await solo.click();
  await expect(solo).toHaveAttribute('aria-pressed', 'true');
  await expect.poll(() => page.evaluate(() => localStorage.getItem('strudel_code')))
    .toContain("const solo = 'main-hook'");

  await mute.click();
  await solo.click();
  const finalHit = graph.locator('.graph-section[data-section="Final hit"]');
  await finalHit.locator('.graph-section-jump').click();
  await expect(graph.locator('.graph-section-name')).toHaveText('Final hit');
  await page.getByRole('button', { name: 'Play', exact: true }).click();
  await expect(page.locator('#mode')).toHaveText('PLAYING');
  await expect(page.getByRole('button', { name: 'Pause', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Stop', exact: true })).toBeEnabled();
  await expect(graph.locator('.graph-pause')).toHaveCount(0);

  await page.evaluate(async () => {
    const { ensureMasterEngine } = await import('/src/audio-engine.js');
    window.__stroodAudioSourceBeforePause = ensureMasterEngine().source;
  });
  await page.getByRole('button', { name: 'Pause', exact: true }).click();
  await expect(page.locator('#mode')).toHaveText('PAUSED');
  await expect(page.getByRole('button', { name: 'Play', exact: true })).toBeVisible();
  await expect.poll(() => page.evaluate(async () => {
    const { ensureMasterEngine } = await import('/src/audio-engine.js');
    const engine = ensureMasterEngine();
    return {
      state: engine.context.state,
      flushed: engine.source !== window.__stroodAudioSourceBeforePause,
    };
  })).toEqual({ state: 'suspended', flushed: true });
  const pausedBar = await graph.locator('.graph-section-cycle').textContent();
  await page.waitForTimeout(700);
  await expect(graph.locator('.graph-section-cycle')).toHaveText(pausedBar);

  await page.getByRole('button', { name: 'Play', exact: true }).click();
  await expect(page.locator('#mode')).toHaveText('PLAYING');
  await expect(page.getByRole('button', { name: 'Pause', exact: true })).toBeVisible();
  await expect.poll(() => page.evaluate(async () => {
    const { ensureMasterEngine } = await import('/src/audio-engine.js');
    return ensureMasterEngine().context.state;
  })).toBe('running');
  const playground = graph.locator('.graph-section[data-section="Playground break"]');
  await playground.locator('.graph-section-jump').click();
  await expect(page.getByRole('button', { name: 'Update', exact: true })).toHaveCount(0);
  await expect.poll(() => graph.locator('.graph-section-name').textContent(), { timeout: 5000 })
    .toBe('Playground break');
  await expect(playground).toHaveClass(/is-current/);
  await page.evaluate(async () => {
    const { ensureMasterEngine } = await import('/src/audio-engine.js');
    window.__stroodAudioSourceBeforeStop = ensureMasterEngine().source;
  });
  await page.getByRole('button', { name: 'Stop', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Play', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Stop', exact: true })).toBeDisabled();
  await expect.poll(() => page.evaluate(async () => {
    const { ensureMasterEngine } = await import('/src/audio-engine.js');
    return ensureMasterEngine().source !== window.__stroodAudioSourceBeforeStop;
  })).toBe(true);

  await finalHit.locator('.graph-section-jump').dblclick();
  await expect(page.locator('#mode')).toHaveText('PLAYING');
  await expect(graph.locator('.graph-section-name')).toHaveText('Final hit');
  await page.getByRole('button', { name: 'Pause', exact: true }).click();
  await expect(page.locator('#mode')).toHaveText('PAUSED');

  await playground.locator('.graph-section-jump').dblclick();
  await expect(page.locator('#mode')).toHaveText('PLAYING');
  await expect(graph.locator('.graph-section-name')).toHaveText('Playground break');
  await expect.poll(() => page.evaluate(async () => {
    const { ensureMasterEngine } = await import('/src/audio-engine.js');
    return ensureMasterEngine().context.state;
  })).toBe('running');
  await page.getByRole('button', { name: 'Stop', exact: true }).click();
});

test('deactivates every visualiser and releases its canvas buffers', async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem('strood:workspace-view', 'graph');
    localStorage.removeItem('strood:visualizers-enabled');
  });
  await page.goto('/');

  const graph = page.getByRole('region', { name: 'Song graph' });
  const toggle = graph.locator('.graph-visualizers-toggle');
  await expect(toggle).toHaveAttribute('aria-label', 'Visualisers enabled');
  await expect(toggle).toHaveAttribute('aria-checked', 'true');
  await page.getByRole('button', { name: 'Play', exact: true }).click();
  await expect.poll(() => page.evaluate(() =>
    window.__stroodVisualizerRegistry?.size || 0), { timeout: 10000 }).toBeGreaterThan(0);
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-checked', 'false');
  await expect(page.locator('body')).toHaveAttribute('data-visualizers', 'off');
  await expect.poll(() => page.evaluate(() => ({
    enabled: window.__stroodVisualizersEnabled,
    visibleSources: window.__stroodGraphVisibleCanvases?.size || 0,
    sourceBuffersReleased: [...(window.__stroodVisualizerRegistry?.values() || [])]
      .every(({ canvas }) => canvas.width === 1 && canvas.height === 1),
    graphBuffersReleased: [...document.querySelectorAll('.graph-visualizer-canvas')]
      .every((canvas) => canvas.width === 1 && canvas.height === 1),
  }))).toEqual({
    enabled: false,
    visibleSources: 0,
    sourceBuffersReleased: true,
    graphBuffersReleased: true,
  });

  await page.getByRole('switch', { name: 'Visualisers disabled' }).click();
  await expect(page.getByRole('switch', { name: 'Visualisers enabled' }))
    .toHaveAttribute('aria-checked', 'true');
  await expect.poll(() => page.evaluate(() =>
    [...(window.__stroodVisualizerRegistry?.values() || [])]
      .some(({ canvas }) => canvas.width > 1 && canvas.height > 1))).toBe(true);
  await page.getByRole('button', { name: 'Stop', exact: true }).click();
});

test('holds a queued section change until the current section ends', async ({ page }) => {
  const song = await fs.readFile(path.resolve(__dirname, '../../songs/kids - mgmt.strudel'), 'utf8');
  await page.addInitScript(({ code }) => {
    localStorage.setItem('strudel_code', code);
    localStorage.setItem('strudel_song_name', 'kids - mgmt');
    localStorage.setItem('strood:workspace-view', 'graph');
  }, { code: song });
  await page.goto('/');

  const graph = page.getByRole('region', { name: 'Song graph' });
  const opening = graph.locator('.graph-section[data-section="Opening hook"]');
  const playground = graph.locator('.graph-section[data-section="Playground break"]');
  await opening.locator('.graph-section-jump').click();
  await expect(graph.locator('.graph-section-name')).toHaveText('Opening hook');
  await page.getByRole('button', { name: 'Play', exact: true }).click();
  await expect.poll(() => graph.locator('.graph-section-cycle').textContent(), { timeout: 4000 })
    .toBe('bar 2/8');
  await playground.locator('.graph-section-jump').click();
  await expect(playground).toHaveClass(/is-queued/);
  await page.waitForTimeout(2300);
  await expect(graph.locator('.graph-section-name')).toHaveText('Opening hook');
  await expect(graph.locator('.graph-section-cycle')).toHaveText('bar 3/8');
  await expect(playground).toHaveClass(/is-queued/);
  await expect(playground.locator('.graph-section-jump'))
    .toHaveAttribute('aria-label', 'Jump to Playground break now');
  await playground.locator('.graph-section-jump').click();
  await expect.poll(() => graph.locator('.graph-section-name').textContent(), { timeout: 3000 })
    .toBe('Playground break');
  await expect(playground).not.toHaveClass(/is-queued/);
  await page.getByRole('button', { name: 'Stop', exact: true }).click();
});

test('loops a graph section until its loop control is pressed again', async ({ page }) => {
  const song = await fs.readFile(path.resolve(__dirname, '../../songs/kids - mgmt.strudel'), 'utf8');
  await page.addInitScript(({ code }) => {
    localStorage.setItem('strudel_code', code);
    localStorage.setItem('strudel_song_name', 'kids - mgmt');
    localStorage.setItem('strood:workspace-view', 'graph');
  }, { code: song });
  await page.goto('/');

  const graph = page.getByRole('region', { name: 'Song graph' });
  const finalHit = graph.locator('.graph-section[data-section="Final hit"]');
  const loop = finalHit.locator('.graph-section-loop');
  await expect(loop).toHaveCSS('opacity', '0');
  await finalHit.hover();
  await expect(loop).toHaveCSS('opacity', '1');
  await loop.click();
  await expect(loop).toHaveAttribute('aria-pressed', 'true');
  await expect(finalHit).toHaveClass(/is-looped/);
  await expect(page.locator('#queue-status')).toBeEmpty();
  await expect.poll(() => page.evaluate(() => localStorage.getItem('strudel_code')))
    .toContain("const songPart = 'Final hit'");
  await expect(page.locator('#mode')).toHaveText('PLAYING');
  await expect.poll(() => graph.locator('.graph-section-name').textContent(), { timeout: 5000 })
    .toBe('Final hit');
  await page.waitForTimeout(2600);
  await expect(graph.locator('.graph-section-name')).toHaveText('Final hit');

  await loop.click();
  await expect(loop).toHaveAttribute('aria-pressed', 'false');
  await expect(finalHit).not.toHaveClass(/is-looped/);
  await expect.poll(() => graph.locator('.graph-section-name').textContent(), { timeout: 6500 })
    .toBe('Opening hook');
  await page.getByRole('button', { name: 'Stop', exact: true }).click();
});

test('starts a newly looped section immediately during playback', async ({ page }) => {
  const song = await fs.readFile(path.resolve(__dirname, '../../songs/kids - mgmt.strudel'), 'utf8');
  await page.addInitScript(({ code }) => {
    localStorage.setItem('strudel_code', code);
    localStorage.setItem('strudel_song_name', 'kids - mgmt');
    localStorage.setItem('strood:workspace-view', 'graph');
  }, { code: song });
  await page.goto('/');

  await expect(page.locator('#limiter-state')).toBeEmpty();

  const graph = page.getByRole('region', { name: 'Song graph' });
  const opening = graph.locator('.graph-section[data-section="Opening hook"]');
  const loop = opening.locator('.graph-section-loop');
  await page.getByRole('button', { name: 'Play', exact: true }).click();
  await expect(page.locator('#mode')).toHaveText('PLAYING');
  await opening.hover();
  await loop.click();
  await expect(opening).toHaveClass(/is-looped/);
  await expect(opening).not.toHaveClass(/is-queued/);
  await expect.poll(() => graph.locator('.graph-section-name').textContent(), { timeout: 1500 })
    .toBe('Opening hook');

  await loop.click();
  await expect(loop).toHaveAttribute('aria-pressed', 'false');
  await expect(opening).not.toHaveClass(/is-looped/);
  await page.getByRole('button', { name: 'Stop', exact: true }).click();
});

test('arms a loop without restarting the section that is already playing', async ({ page }) => {
  const song = await fs.readFile(path.resolve(__dirname, '../../songs/kids - mgmt.strudel'), 'utf8');
  await page.addInitScript(({ code }) => {
    localStorage.setItem('strudel_code', code);
    localStorage.setItem('strudel_song_name', 'kids - mgmt');
    localStorage.setItem('strood:workspace-view', 'graph');
  }, { code: song });
  await page.goto('/');

  const graph = page.getByRole('region', { name: 'Song graph' });
  const playground = graph.locator('.graph-section[data-section="Playground break"]');
  await page.getByRole('button', { name: 'Play', exact: true }).click();
  await expect.poll(() => playground.evaluate((element) =>
    Number.parseFloat(element.style.getPropertyValue('--section-progress'))), {
    timeout: 5000,
  }).toBeGreaterThan(28);
  const progressBefore = await playground.evaluate((element) =>
    Number.parseFloat(element.style.getPropertyValue('--section-progress')));

  await playground.hover();
  await playground.locator('.graph-section-loop').click();
  await expect(page.locator('body')).toHaveAttribute('data-update-state', 'queued');
  await page.waitForTimeout(350);
  const progressAfter = await playground.evaluate((element) =>
    Number.parseFloat(element.style.getPropertyValue('--section-progress')));

  expect(progressAfter).toBeGreaterThan(progressBefore);
  await expect(playground).toHaveClass(/is-looped/);
  await page.getByRole('button', { name: 'Stop', exact: true }).click();
});

test('mutes and unmutes the currently sounding vocal orbit immediately', async ({ page }) => {
  const song = await fs.readFile(path.resolve(__dirname, '../../songs/kids - mgmt.strudel'), 'utf8');
  await page.addInitScript(({ code }) => {
    localStorage.setItem('strudel_code', code);
    localStorage.setItem('strudel_song_name', 'kids - mgmt');
    localStorage.setItem('strood:workspace-view', 'graph');
  }, { code: song });
  await page.goto('/');

  const graph = page.getByRole('region', { name: 'Song graph' });
  await page.getByRole('button', { name: 'Play', exact: true }).click();
  await expect.poll(() => page.evaluate(async () => {
    const { ensureMasterEngine } = await import('/src/audio-engine.js');
    return Boolean(ensureMasterEngine().controller.nodes[9]?.output?.gain);
  }), { timeout: 10000 }).toBe(true);

  await graph.getByRole('button', { name: 'Mute Hard-tuned lo-fi vocal' }).click();
  await expect.poll(() => page.evaluate(async () => {
    const { ensureMasterEngine } = await import('/src/audio-engine.js');
    return ensureMasterEngine().controller.nodes[9].output.gain.value;
  }), { timeout: 1000 }).toBeCloseTo(0, 2);

  await graph.getByRole('button', { name: 'Unmute Hard-tuned lo-fi vocal' }).click();
  await expect.poll(() => page.evaluate(async () => {
    const { ensureMasterEngine } = await import('/src/audio-engine.js');
    return ensureMasterEngine().controller.nodes[9].output.gain.value;
  }), { timeout: 1000 }).toBeCloseTo(1, 2);
  await page.getByRole('button', { name: 'Stop', exact: true }).click();
});

test('plays the hard-tuned lo-fi vocal stem from the selected song section', async ({ page }) => {
  const song = await fs.readFile(path.resolve(__dirname, '../../songs/kids - mgmt.strudel'), 'utf8');
  await page.addInitScript(({ code }) => {
    localStorage.setItem('strudel_code', code);
    localStorage.setItem('strudel_song_name', 'kids - mgmt');
    localStorage.setItem('strood:workspace-view', 'graph');
  }, { code: song });
  const vocalAsset = page.waitForResponse((response) =>
    response.url().endsWith('/audio/kids-vocals-tuned-lofi.mp3') && response.status() === 200);
  await page.goto('/');

  const graph = page.getByRole('region', { name: 'Song graph' });
  await graph.getByRole('button', { name: 'Solo Hard-tuned lo-fi vocal' }).click();
  await graph.locator('.graph-section[data-section="Verse one"] .graph-section-jump').dblclick();
  await vocalAsset;
  await expect(page.locator('#diagnostics')).toBeHidden();
  await expect.poll(async () => await page.locator('#master-level').getAttribute('style') || '', {
    timeout: 10000,
  }).not.toContain('scaleX(0)');
  await expect(graph.locator('[data-source-name="vocals"]')).toBeVisible();
  const vocalWaveform = graph.getByRole('article', {
    name: 'waveform visualiser connected to vocals',
  });
  await expect(vocalWaveform).toBeVisible();
  await expect.poll(() => vocalWaveform.locator('canvas').evaluate((canvas) => {
    const pixels = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
    let visible = 0;
    for (let index = 3; index < pixels.length; index += 4) {
      if (pixels[index] > 8) visible += 1;
    }
    return visible;
  }), { timeout: 10000 }).toBeGreaterThan(100);
  await expect.poll(() => vocalWaveform.locator('canvas').evaluate((canvas) => {
    const pixels = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
    let top = canvas.height;
    let bottom = -1;
    for (let y = 0; y < canvas.height; y += 1) {
      for (let x = 0; x < canvas.width; x += 1) {
        if (pixels[(y * canvas.width + x) * 4 + 3] <= 8) continue;
        top = Math.min(top, y);
        bottom = Math.max(bottom, y);
      }
    }
    return bottom < top ? 0 : (bottom - top + 1) / canvas.height;
  }), { timeout: 10000 }).toBeGreaterThan(.15);
  await expect(graph.locator('[data-source-name="verseOneVocal"], [data-source-name="verseTwoVocal"], [data-source-name="chorusVocal"], [data-source-name="vocalSong"], [data-source-name="vocalGuide"]'))
    .toHaveCount(0);
  await page.getByRole('button', { name: 'Stop', exact: true }).click();
});

test('auto-ranges a quiet synth waveform to fill its visualiser', async ({ page }) => {
  const song = await fs.readFile(path.resolve(__dirname, '../../songs/kids - mgmt.strudel'), 'utf8');
  await page.addInitScript(({ code }) => {
    localStorage.setItem('strudel_code', code);
    localStorage.setItem('strudel_song_name', 'kids - mgmt');
    localStorage.setItem('strood:workspace-view', 'graph');
  }, { code: song });
  await page.goto('/');

  const graph = page.getByRole('region', { name: 'Song graph' });
  await graph.getByRole('button', { name: 'Solo Pulse-wave answer' }).click();
  await graph.locator('.graph-section[data-section="Full intro"] .graph-section-jump').dblclick();
  await expect(page.locator('#mode')).toHaveText('PLAYING');
  const claviPhrase = graph.locator('[data-source-name="claviPhrase"]');
  const claviArrangement = graph.locator('[data-source-name="claviSong"]');
  await expect(claviArrangement).toHaveClass(/has-active-arrangement/);
  await expect(claviArrangement.locator('.graph-arrangement-entry.is-active-arrangement').filter({
    hasText: 'claviPhrase',
  })).toHaveCount(1);
  await expect.poll(() => claviPhrase.evaluate((element) => element.classList.contains('is-sounding')))
    .toBe(true);
  await expect(claviPhrase.locator('.graph-pattern-activity')).toHaveCSS('opacity', '1');
  await claviPhrase.hover();
  await claviPhrase.getByRole('button', { name: 'Add visualiser to claviPhrase' }).click();
  await graph.getByRole('menuitem', { name: 'Waveform' }).click();
  await expect(page.locator('body')).not.toHaveAttribute('data-update-state', 'queued');
  const waveform = page.getByRole('article', {
    name: 'waveform visualiser connected to claviPhrase',
  });
  await expect(waveform).toBeVisible();
  await expect.poll(() => waveform.locator('canvas').evaluate((canvas) => {
    const pixels = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
    let top = canvas.height;
    let bottom = -1;
    for (let y = 0; y < canvas.height; y += 1) {
      for (let x = 0; x < canvas.width; x += 1) {
        if (pixels[(y * canvas.width + x) * 4 + 3] <= 8) continue;
        top = Math.min(top, y);
        bottom = Math.max(bottom, y);
      }
    }
    return bottom < top ? 0 : (bottom - top + 1) / canvas.height;
  }), { timeout: 2000 }).toBeGreaterThan(.35);
  await page.getByRole('button', { name: 'Stop', exact: true }).click();
});

test('cues the playground toys after the current section while playing', async ({ page }) => {
  const song = await fs.readFile(path.resolve(__dirname, '../../songs/kids - mgmt.strudel'), 'utf8');
  await page.addInitScript(({ code }) => {
    localStorage.setItem('strudel_code', code);
    localStorage.setItem('strudel_song_name', 'kids - mgmt');
    localStorage.setItem('strood:workspace-view', 'code');
  }, { code: song });
  await page.goto('/');
  await page.getByRole('button', { name: /Choose song part, current/ }).click();
  await page.getByRole('option', { name: 'Final hit', exact: true }).click();
  await page.getByRole('button', { name: 'Play', exact: true }).click();
  await expect(page.getByRole('status').filter({ hasText: 'PLAYING' })).toBeVisible();

  await page.getByRole('button', { name: /Choose song part, current/ }).click();
  await page.getByRole('option', { name: 'Playground break', exact: true }).click();
  await page.getByRole('button', { name: /Solo track, current/ }).click();
  await page.getByRole('option', { name: 'playground-tape', exact: true }).click();
  await page.getByRole('button', { name: 'Graph', exact: true }).click();

  await expect.poll(() => page.locator('[data-source-name="playgroundToys"].is-sounding').count(), {
    timeout: 5000,
  }).toBe(1);
  await expect.poll(() => page.locator('[data-source-name="playgroundToys"] .is-active-note').count())
    .toBeGreaterThan(0);
  await expect(page.locator('[aria-label*="cymatics visualiser"].is-sounding')).toHaveCount(1);
  await expect.poll(async () => await page.locator('#master-level').getAttribute('style') || '')
    .not.toContain('scaleX(0)');
  await page.getByRole('button', { name: 'Stop', exact: true }).click();
});

test('opens the searchable song browser and patch module palette', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Open' }).click();
  await expect(page.getByRole('dialog', { name: 'Saved songs' })).toBeVisible();
  await expect(page.getByRole('searchbox', { name: 'Filter saved songs' })).toBeFocused();
  await page.getByRole('button', { name: 'Close' }).click();

  await page.getByRole('button', { name: 'Patch' }).click();
  await expect(page.getByRole('dialog', { name: 'Patch studio' })).toBeVisible();
  await page.getByRole('button', { name: 'add module' }).click();
  await expect(page.getByRole('dialog', { name: 'Add synth module' })).toBeVisible();
  await expect(page.getByRole('searchbox', { name: 'Find a synth module' })).toBeFocused();
  await expect(page.getByRole('button', { name: 'vocal voice' })).toBeVisible();
});

test('edits mastering controls in the song source', async ({ page }) => {
  await page.goto('/');
  const vocalSynth = page.getByRole('button', { name: /Choose vocal synth/ });
  await expect(vocalSynth).toBeVisible();
  await vocalSynth.click();
  await page.getByRole('option', { name: 'triangle', exact: true }).click();
  await expect.poll(() => page.evaluate(() => localStorage.getItem('strudel_code')))
    .toContain("const vocalSynth = 'triangle'");

  await page.getByRole('button', { name: /Solo track/ }).click();
  await page.getByRole('option', { name: 'bass', exact: true }).click();
  await expect.poll(() => page.evaluate(() => localStorage.getItem('strudel_code')))
    .toContain("const solo = 'bass'");

  await page.locator('.cm-smart-boolean[data-smart-name="mute"]').first().click();
  await expect.poll(() => page.evaluate(() => localStorage.getItem('strudel_code')))
    .toContain('mute: true');

  const master = page.locator('.cm-smart-number[data-smart-name="master"]');
  await expect(master).toBeVisible();
  await master.click();
  await page.keyboard.press('ArrowRight');
  await expect.poll(() => page.evaluate(() => localStorage.getItem('strudel_code')))
    .toContain('const master = .26');
  const box = await master.boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await expect(page.locator('.cm-number-hud')).toBeVisible();
  await expect(page.locator('.cm-number-hud-value')).toHaveText('26% master');
  await page.mouse.move(box.x + box.width / 2 + 20, box.y + box.height / 2);
  await page.mouse.up();
  await expect.poll(() => page.evaluate(() => localStorage.getItem('strudel_code')))
    .toMatch(/const master = (?!\.25\b)/);

  const editor = page.getByRole('textbox', { name: 'Song code', exact: true });
  await editor.click();
  await page.keyboard.press('Control+Home');
  await page.keyboard.type('// source remains editable\n');
  await expect.poll(() => page.evaluate(() => localStorage.getItem('strudel_code')))
    .toContain('// source remains editable');

  await expect(page.getByRole('combobox', { name: 'Visualiser placement' })).toHaveCount(0);
  await expect(page.locator('#boot-status')).toHaveCount(0);
});

test('plays the source-mastered song through the protected output', async ({ page }) => {
  await page.goto('/');
  const initialPlayBox = await page.getByRole('button', { name: 'Play', exact: true }).boundingBox();
  const initialStopBox = await page.getByRole('button', { name: 'Stop', exact: true }).boundingBox();
  const initialSaveBox = await page.getByRole('button', { name: 'Save', exact: true }).boundingBox();
  await expect(page.getByRole('button', { name: 'Stop', exact: true })).toBeDisabled();
  await page.getByRole('button', { name: 'Play', exact: true }).click();
  await expect(page.getByRole('status').filter({ hasText: 'PLAYING' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Pause', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Stop', exact: true })).toBeEnabled();
  await expect(page.getByRole('button', { name: 'Update', exact: true })).toHaveCount(0);
  await expect(page.locator('#save-state')).toBeHidden();

  await page.getByRole('button', { name: 'Graph' }).click();
  await expect.poll(() => page.evaluate(() => {
    const methods = [...(window.__stroodVisualizerRegistry?.values() || [])]
      .map(({ method }) => method);
    const visible = window.__stroodGraphVisibleCanvases;
    const mirrored = [...document.querySelectorAll('.graph-visualizer-canvas')].map((canvas) => {
      const data = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
      for (let index = 3; index < data.length; index += 16) {
        if (data[index] > 8) return true;
      }
      return false;
    });
    return {
      methods,
      visibleSources: visible?.size || 0,
      mirrored,
    };
  }), { timeout: 10000 }).toEqual({
    methods: ['_spiral', '_scope', '_lissajous', '_orbit'],
    visibleSources: 4,
    mirrored: [true, true, true, true],
  });
  await page.getByRole('button', { name: 'Code' }).click();

  const editor = page.getByRole('textbox', { name: 'Song code', exact: true });
  await editor.click();
  await page.keyboard.press('Control+Home');
  await page.keyboard.type('// update action check\n');
  const updateButton = page.getByRole('button', { name: 'Update', exact: true });
  await expect(updateButton).toBeVisible();
  const updateBox = await updateButton.boundingBox();
  const playingPauseBox = await page.getByRole('button', { name: 'Pause', exact: true }).boundingBox();
  const playingStopBox = await page.getByRole('button', { name: 'Stop', exact: true }).boundingBox();
  const playingSaveBox = await page.getByRole('button', { name: 'Save', exact: true }).boundingBox();
  expect(updateBox.x).toBeLessThan(playingPauseBox.x);
  expect(playingPauseBox.x).toBe(initialPlayBox.x);
  expect(playingStopBox.x).toBe(initialStopBox.x);
  expect(playingSaveBox.x).toBe(initialSaveBox.x);
  await expect(page.locator('#save-state')).toHaveText('Unsaved');
  await page.getByRole('button', { name: 'Update', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Update', exact: true })).toHaveCount(0, { timeout: 10000 });
  await expect(page.getByRole('button', { name: 'Stop', exact: true })).toBeVisible();
  await expect.poll(async () => await page.locator('#master-level').getAttribute('style') || '', { timeout: 15000 })
    .not.toContain('scaleX(0)');
  const outputSafety = await page.evaluate(async () => {
    const samples = [];
    for (let index = 0; index < 60; index += 1) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      const limiterLabel = document.querySelector('#limiter-state')?.textContent || '';
      const limiterMatch = /lim\s+(-?[\d.]+)/i.exec(limiterLabel);
      samples.push({
        limiter: limiterMatch ? Number(limiterMatch[1]) : 0,
        peak: Number.parseFloat(document.querySelector('#master-peak')?.style.left || '0'),
      });
    }
    return {
      worstLimiter: Math.min(...samples.map(({ limiter }) => limiter)),
      maxPeak: Math.max(...samples.map(({ peak }) => peak)),
    };
  });
  // -1 dB rather than -0.5: under --mute-audio Chromium renders via its fake
  // output stream, whose timing shifts the sampled window enough to read up to
  // ~-0.9 dB on a healthy master. An unmastered mix slams several dB past this.
  expect(outputSafety.worstLimiter).toBeGreaterThanOrEqual(-1);
  expect(outputSafety.maxPeak).toBeLessThanOrEqual(99);
  await expect(page.locator('#diagnostics')).toBeHidden();

  await page.evaluate(async () => {
    const { ensureMasterEngine } = await import('/src/audio-engine.js');
    await ensureMasterEngine().context.suspend();
  });
  await expect.poll(() => page.evaluate(async () => {
    const { ensureMasterEngine } = await import('/src/audio-engine.js');
    return ensureMasterEngine().context.state;
  })).toBe('running');
  await expect(page.getByRole('status').filter({ hasText: 'PLAYING' })).toBeVisible();
  await page.getByRole('button', { name: 'Stop', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Play', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Stop', exact: true })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Update', exact: true })).toHaveCount(0);
});

test('re-primes audio after returning from another application', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Play', exact: true }).click();
  await expect(page.getByRole('status').filter({ hasText: 'PLAYING' })).toBeVisible();

  await page.evaluate(async () => {
    const { ensureMasterEngine } = await import('/src/audio-engine.js');
    const context = ensureMasterEngine().context;
    const originalSuspend = context.suspend.bind(context);
    const originalResume = context.resume.bind(context);
    window.__audioWakeCalls = { suspend: 0, resume: 0 };
    context.suspend = (...args) => {
      window.__audioWakeCalls.suspend += 1;
      return originalSuspend(...args);
    };
    context.resume = (...args) => {
      window.__audioWakeCalls.resume += 1;
      return originalResume(...args);
    };
    window.dispatchEvent(new Event('blur'));
    window.dispatchEvent(new Event('focus'));
  });

  await expect.poll(() => page.evaluate(async () => {
    const { ensureMasterEngine } = await import('/src/audio-engine.js');
    return {
      ...window.__audioWakeCalls,
      state: ensureMasterEngine().context.state,
    };
  })).toEqual({ suspend: 1, resume: 1, state: 'running' });
  await expect.poll(async () => await page.locator('#master-level').getAttribute('style') || '', {
    timeout: 10000,
  }).not.toContain('scaleX(0)');
  await page.getByRole('button', { name: 'Stop', exact: true }).click();
});

test('uses keyboard-safe app dialogs instead of native prompts', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'New' }).click();
  await page.getByRole('button', { name: 'Save' }).click();
  const dialog = page.getByRole('dialog', { name: 'Save song' });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole('textbox', { name: 'Song name' })).toBeFocused();
  await dialog.getByRole('button', { name: 'Cancel' }).click();
  await expect(dialog).toBeHidden();
});

test('uses linked editor views for multi-column mode', async ({ page }) => {
  await page.goto('/');
  const editor = page.getByRole('textbox', { name: 'Song code', exact: true });
  await editor.click();
  await page.keyboard.press('Control+2');
  await expect(page.locator('.editor-panel')).toHaveCount(2);
  const secondEditor = page.getByRole('textbox', { name: 'Song code, column 2' });
  await expect(secondEditor).toBeVisible();
  const originalLength = Number(await editor.getAttribute('data-document-length'));
  await editor.click();
  await page.keyboard.press('Control+Home');
  await page.keyboard.type('// linked view check\n');
  await expect.poll(async () => {
    const primaryLength = Number(await editor.getAttribute('data-document-length'));
    const secondaryLength = Number(await secondEditor.getAttribute('data-document-length'));
    return { linked: primaryLength === secondaryLength, increased: primaryLength > originalLength };
  }).toEqual({ linked: true, increased: true });
});

test('has no automatically detectable accessibility violations', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('button', { name: 'Play', exact: true })).toBeVisible();

  const studioAudit = await new AxeBuilder({ page }).analyze();
  expect(studioAudit.violations).toEqual([]);

  await page.getByRole('button', { name: 'Patch', exact: true }).click();
  await expect(page.getByRole('dialog', { name: 'Patch studio' })).toBeVisible();
  const patchAudit = await new AxeBuilder({ page }).analyze();
  expect(patchAudit.violations).toEqual([]);
});

test('versions song saves and rejects a stale overwrite', async ({ request }) => {
  const name = `strood api test ${Date.now()}`;
  const encodedName = encodeURIComponent(name);
  const songPath = path.join(process.cwd(), 'songs', `${name}.strudel`);
  const historyPath = path.join(
    process.cwd(),
    'songs',
    '.history',
    crypto.createHash('sha1').update(name).digest('hex').slice(0, 16),
  );

  try {
    const first = await request.put(`/api/songs/${encodedName}`, { data: 'first version' });
    expect(first.ok()).toBeTruthy();
    const firstVersion = first.headers().etag;

    const second = await request.put(`/api/songs/${encodedName}`, {
      data: 'second version',
      headers: { 'If-Match': firstVersion },
    });
    expect(second.ok()).toBeTruthy();

    const conflict = await request.put(`/api/songs/${encodedName}`, {
      data: 'stale overwrite',
      headers: { 'If-Match': firstVersion },
    });
    expect(conflict.status()).toBe(409);
    await expect(conflict.json()).resolves.toMatchObject({ code: 'version_conflict' });

    const history = await request.get(`/api/songs/${encodedName}/history`);
    expect(await history.json()).toHaveLength(1);
  } finally {
    await fs.rm(songPath, { force: true });
    await fs.rm(historyPath, { recursive: true, force: true });
  }
});

test('keeps transport, inline controls and editor usable on a narrow screen', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/');
  await expect(page.getByRole('button', { name: 'Play', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: /Solo track/ })).toBeVisible();
  await expect(page.getByRole('textbox', { name: 'Song code', exact: true })).toBeVisible();
  const hasPageOverflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
  expect(hasPageOverflow).toBe(false);
});

test('turns the source into a playback-linked executable score', async ({ page }) => {
  await page.goto('/');
  const editor = page.getByRole('textbox', { name: 'Song code', exact: true });
  await expect(page.locator('.score-beat-rail')).toHaveCount(0);

  await page.locator('.cm-scroller').evaluate((element) => { element.scrollTop = element.scrollHeight; });
  await expect(page.locator('.cm-track-start').first()).toBeVisible();
  await expect(page.locator('.cm-track-start').first()).toHaveAttribute('data-track-color', /.+/);

  await page.getByRole('button', { name: 'Play', exact: true }).click();
  await expect.poll(() => page.locator('.cm-content canvas[id^="_widget"][data-track]').count(), { timeout: 10000 })
    .toBeGreaterThan(0);
  const inlineVisualizer = page.locator('.cm-content canvas[id^="_widget"][data-track]').first();
  await expect.poll(() => inlineVisualizer.evaluate((canvas) => ({
    position: getComputedStyle(canvas).position,
    ratioPreserved: Math.abs(
      canvas.getBoundingClientRect().width / canvas.getBoundingClientRect().height
      - canvas.width / canvas.height
    ) < 0.02,
    followsCompletedExpression: /^\._/.test(canvas.previousElementSibling?.textContent?.trim() || ''),
  }))).toEqual({ position: 'relative', ratioPreserved: true, followsCompletedExpression: true });

  const scroller = page.locator('.cm-scroller');
  await scroller.evaluate((element) => {
    element.scrollTop = Math.floor((element.scrollHeight - element.clientHeight) * 0.45);
  });
  await page.waitForTimeout(250);
  const settledScrollTop = await scroller.evaluate((element) => element.scrollTop);
  await page.waitForTimeout(700);
  const stableScrollTop = await scroller.evaluate((element) => element.scrollTop);
  expect(Math.abs(stableScrollTop - settledScrollTop)).toBeLessThanOrEqual(2);

  await editor.click();
  await page.keyboard.press('Control+Home');
  await page.keyboard.type('// queued feedback\n');
  await page.keyboard.press('Control+Enter');
  await expect(page.locator('body')).toHaveAttribute('data-update-state', 'queued');
  await page.keyboard.type('// typed after queue\n');
  await expect.poll(() => page.locator('body').getAttribute('data-update-state'), { timeout: 6000 }).not.toBe('queued');
  await expect.poll(() => page.locator('#editors-container').getAttribute('data-evaluated-length'))
    .toBe(await editor.getAttribute('data-document-length'));

  await editor.click();
  await page.keyboard.press('Control+Shift+f');
  await expect(page.locator('body')).toHaveClass(/performance-mode/);
  await expect(page.locator('#transport')).toBeHidden();
  await page.keyboard.press('Escape');
  await expect(page.locator('#transport')).toBeVisible();
});

test('links modular patches back to their source sound', async ({ page }) => {
  await page.goto('/');
  const vocalSynth = page.getByRole('button', { name: /Choose vocal synth/ });
  await vocalSynth.click();
  await page.getByRole('option', { name: 'vox', exact: true }).click();

  await page.getByRole('button', { name: 'Patch', exact: true }).click();
  const patch = page.getByRole('dialog', { name: 'Patch studio' });
  await expect(patch).toBeVisible();
  await patch.getByRole('combobox', { name: 'Current synth patch' }).selectOption('vox-pad');
  await expect(patch.locator('.pe-node').first()).toBeVisible();

  await patch.locator('.pe-node').first().hover();
  await expect(page.locator('.cm-inline-choice.is-patch-linked[data-smart-value="vox"]')).toBeVisible();
  await vocalSynth.hover();
  await expect(patch.locator('.pe-node.source-linked').first()).toBeVisible();
});
