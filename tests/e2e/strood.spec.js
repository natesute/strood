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
  await expect(graph.locator('.graph-pattern-activity')).toHaveCount(0);
  await expect(graph.locator('.graph-visualizer-node').first()).toBeVisible();
  const graphOwnership = await graph.evaluate((root) => {
    const tracks = [...root.querySelectorAll('.graph-track-node')];
    const visualEdges = [...root.querySelectorAll('.graph-visual-edge')];
    return {
      trackCount: tracks.length,
      plusCount: root.querySelectorAll('.graph-node-add-visualizer').length,
      nonTrackPlusCount: root.querySelectorAll('.graph-node:not(.graph-track-node) .graph-node-add-visualizer').length,
      visualEdgesFromTracks: visualEdges.every((edge) =>
        root.querySelector(`[data-node-id="${CSS.escape(edge.dataset.from)}"]`)
          ?.classList.contains('graph-track-node')),
    };
  });
  expect(graphOwnership.plusCount).toBe(graphOwnership.trackCount);
  expect(graphOwnership).toMatchObject({ nonTrackPlusCount: 0, visualEdgesFromTracks: true });
  expect(await graph.locator('.graph-code-node').evaluateAll((nodes) => nodes.every((node) => {
    const header = node.querySelector('.graph-node-header');
    const identity = node.querySelector('.graph-node-identity');
    if (!header || !identity || node.querySelector('.graph-node-kind')) return false;
    const headerBounds = header.getBoundingClientRect();
    const bounds = identity.getBoundingClientRect();
    return bounds.left >= headerBounds.left - 1
      && bounds.right <= headerBounds.right + 1
      && bounds.top >= headerBounds.top - 1
      && bounds.bottom <= headerBounds.bottom + 1
      && getComputedStyle(identity).textOverflow !== 'ellipsis'
      && identity.textContent.length > 0;
  }))).toBe(true);
  await expect(graph.locator('.graph-toolbar, .graph-fit-all, .graph-actual-size, .graph-arrange'))
    .toHaveCount(0);
  expect(await graph.locator('.graph-viewport').evaluate((viewport) => {
    const surface = viewport.querySelector('.graph-surface').getBoundingClientRect();
    const frame = viewport.getBoundingClientRect();
    return surface.width <= frame.width + 1 && surface.height <= frame.height + 1;
  })).toBe(true);
  expect(await graph.locator('.graph-edge').evaluateAll((edges) => edges.every((edge) => {
    const style = getComputedStyle(edge);
    const channels = style.stroke.match(/[\d.]+/g)?.map(Number) || [];
    const strokeAlpha = channels.length === 4 ? channels[3] : 1;
    return style.opacity === '1' && strokeAlpha === 1;
  }))).toBe(true);
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
      const points = JSON.parse(edge.dataset.route || '[]');
      const crossingCount = Number(edge.dataset.crossings) || 0;
      if (!points.length || (crossingCount > 0) !== path.includes(' C ')) return false;
      for (let index = 1; index < points.length; index++) {
        const from = points[index - 1];
        const to = points[index];
        if (from.x !== to.x && from.y !== to.y) return false;
        if (nodes.some((node) => node.id !== edge.dataset.from && node.id !== edge.dataset.to
          && crosses(from, to, {
            left: node.left - 10,
            right: node.right + 10,
            top: node.top - 10,
            bottom: node.bottom + 10,
          }))) return false;
      }
      return true;
    });
  })).toBe(true);

  await page.clock.install();
  await page.clock.pauseAt(new Date());
  const liveStatePromise = graph.evaluate(async (root) => {
    const noteNode = root.querySelector('.graph-notes-node');
    const noteTokens = [...noteNode.querySelectorAll('.graph-source-token')];
    const token = noteTokens[0];
    const neighbouringTokens = noteTokens.slice(1, 5);
    const visualizerNode = root.querySelector('.graph-visualizer-node');
    const surfaceAlpha = (element) => Number(
      getComputedStyle(element).backgroundColor.match(/[\d.]+/g)?.[3] || 1,
    );
    const arrangementEntry = document.createElement('span');
    arrangementEntry.className = 'graph-arrangement-entry is-active-arrangement';
    arrangementEntry.style.setProperty('--pattern-activity-color', '#e6b450');
    arrangementEntry.textContent = 'phrase';
    root.appendChild(arrangementEntry);
    const stableStyle = (element) => {
      const style = getComputedStyle(element);
      return [style.borderColor, style.backgroundColor, style.boxShadow];
    };
    const noteStyleBefore = stableStyle(noteNode);
    const visualizerStyleBefore = stableStyle(visualizerNode);
    const edge = root.querySelector('.graph-edge[data-edge-id]');
    const edgeStyleBefore = stableStyle(edge);
    const arrangementStyle = getComputedStyle(arrangementEntry);
    const arrangementBackground = arrangementStyle.backgroundColor;
    const arrangementChannels = arrangementBackground.match(/[\d.]+/g)?.map(Number) || [];
    const solidArrangement = arrangementBackground !== 'rgba(0, 0, 0, 0)'
      && (arrangementChannels.length < 4 || arrangementChannels[3] === 1)
      && arrangementStyle.boxShadow === 'none';
    arrangementEntry.remove();
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
    const onsetStyle = getComputedStyle(token);
    const onsetBackground = onsetStyle.backgroundColor;
    const onsetShadow = onsetStyle.boxShadow;
    const onsetTextColor = getComputedStyle(token).color;
    const activationColor = getComputedStyle(token).getPropertyValue('--note-activation-color');
    const notes = Boolean(token.closest('.graph-node')?.classList.contains('is-sounding'));
    const visualizer = Boolean(root.querySelector('.graph-visualizer-node.is-sounding'));
    document.dispatchEvent(new CustomEvent('strood:note-activity', {
      detail: { activations: [] },
    }));
    const retainedAfterEmptyFrame = token.classList.contains('is-active-note');
    window.__stroodHighlightTestPhase = 'onset';
    await new Promise((resolve) => setTimeout(resolve, 55));
    const sustainedOnset = token.classList.contains('is-note-onset');
    const sustainedHighlight = token.classList.contains('is-active-note');
    const sustainedStyle = getComputedStyle(token);
    const sustainedBackground = sustainedStyle.backgroundColor;
    const sustainedShadow = sustainedStyle.boxShadow;
    const sustainedTextColor = getComputedStyle(token).color;
    const tokenBounds = token.getBoundingClientRect();
    const sourceBounds = token.closest('.graph-source-wrap').getBoundingClientRect();
    window.__stroodHighlightTestPhase = 'sustain';
    await new Promise((resolve) => setTimeout(resolve, 140));
    delete window.__stroodHighlightTestPhase;
    return {
      token: tokenActive,
      onset,
      onsetBackground,
      onsetShadow,
      onsetTextColor,
      retainedAfterEmptyFrame,
      sustainedOnset,
      sustainedHighlight,
      sustainedBackground,
      sustainedShadow,
      sustainedTextColor,
      staccatoExpired: !token.classList.contains('is-active-note'),
      activationColor,
      notes,
      visualizer,
      visible: tokenBounds.top >= sourceBounds.top - 1
        && tokenBounds.bottom <= sourceBounds.bottom + 1
        && tokenBounds.left >= sourceBounds.left - 1
        && tokenBounds.right <= sourceBounds.right + 1,
      // Organic layouts show structure at the fitted zoom and rely on
      // zooming (or the shift lens) for close reading; tokens just need to
      // stay legible as shapes.
      readable: tokenBounds.height >= 5.5,
      stableNode: JSON.stringify(noteStyleBefore) === JSON.stringify(stableStyle(noteNode)),
      stableVisualizer: JSON.stringify(visualizerStyleBefore) === JSON.stringify(stableStyle(visualizerNode)),
      stableEdge: JSON.stringify(edgeStyleBefore) === JSON.stringify(stableStyle(edge)),
      solidArrangement,
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
      nodeAlpha: surfaceAlpha(root.querySelector('.graph-declaration-node')),
      notesAlpha: surfaceAlpha(noteNode),
      visualizerAlpha: surfaceAlpha(visualizerNode),
    };
  });
  await expect.poll(() => page.evaluate(() => window.__stroodHighlightTestPhase))
    .toBe('onset');
  await page.clock.runFor(55);
  await expect.poll(() => page.evaluate(() => window.__stroodHighlightTestPhase))
    .toBe('sustain');
  await page.clock.runFor(140);
  const liveState = await liveStatePromise;
  await page.clock.resume();
  expect(liveState).toEqual({
    token: true,
    onset: true,
    onsetBackground: 'rgb(255, 255, 255)',
    onsetShadow: 'none',
    onsetTextColor: 'rgb(255, 255, 255)',
    retainedAfterEmptyFrame: true,
    sustainedOnset: false,
    sustainedHighlight: true,
    sustainedBackground: 'rgb(255, 136, 68)',
    sustainedShadow: 'none',
    sustainedTextColor: 'rgb(255, 255, 255)',
    staccatoExpired: true,
    activationColor: '#ff8844',
    notes: true,
    visualizer: true,
    visible: true,
    readable: true,
    stableNode: true,
    stableVisualizer: true,
    stableEdge: true,
    solidArrangement: true,
    stableTextLayout: true,
    highlightedEdges: 0,
    subheading: false,
    stripe: true,
    fontSize: '12px',
    outputPorts: 0,
    hiddenPorts: true,
    nodeAlpha: 0.435,
    notesAlpha: 0.392,
    visualizerAlpha: 0.35,
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

  await followedWrapper.evaluate((wrapper) => { wrapper.scrollTop = 0; });
  const graphTransformBeforeNodeScroll = await graph.locator('.graph-surface')
    .evaluate((surface) => surface.style.transform);
  await followedWrapper.hover();
  await page.mouse.wheel(0, 180);
  await expect.poll(() => followedWrapper.evaluate((wrapper) => wrapper.scrollTop))
    .toBeGreaterThan(0);
  await expect(followedNode.getByRole('textbox')).not.toBeFocused();
  expect(await graph.locator('.graph-surface').evaluate((surface) => surface.style.transform))
    .toBe(graphTransformBeforeNodeScroll);

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
  const controlAppearance = await declaration.evaluate((node) => {
    const toggles = [...node.querySelectorAll('.graph-track-toggle')];
    const plus = node.querySelector('.graph-node-add-visualizer');
    const alpha = (element) => {
      const channels = getComputedStyle(element).backgroundColor.match(/[\d.]+/g)?.map(Number) || [];
      return channels.length === 4 ? channels[3] : 1;
    };
    const borderAlpha = (element) => {
      const channels = getComputedStyle(element).borderColor.match(/[\d.]+/g)?.map(Number) || [];
      return channels.length === 4 ? channels[3] : 1;
    };
    return {
      togglesInvisible: toggles.every((toggle) => alpha(toggle) === 0 && borderAlpha(toggle) === 0),
      toggleFontSizes: toggles.map((toggle) => getComputedStyle(toggle).fontSize),
      order: [...node.querySelectorAll('.graph-track-controls > button')]
        .map((button) => button.classList.contains('graph-node-add-visualizer') ? '+' : button.textContent),
      plusAlpha: alpha(plus),
      plusBorderWidth: getComputedStyle(plus).borderTopWidth,
      plusColor: getComputedStyle(plus).color,
      plusOpacity: getComputedStyle(plus).opacity,
      plusAtTopRight: getComputedStyle(plus).right === '5px'
        && getComputedStyle(plus).top === '3px',
    };
  });
  expect(controlAppearance).toEqual({
    togglesInvisible: true,
    toggleFontSizes: ['10px', '10px'],
    order: ['M', 'S', '+'],
    plusAlpha: 0,
    plusBorderWidth: '0px',
    plusColor: 'rgb(125, 135, 149)',
    plusOpacity: '1',
    plusAtTopRight: true,
  });
  const visualizerNode = graph.locator('.graph-visualizer-node').first();
  const deleteVisualizerButton = visualizerNode.locator('.graph-visualizer-delete');
  await expect(deleteVisualizerButton).toHaveCSS('opacity', '0');
  await expect(deleteVisualizerButton).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
  await expect(deleteVisualizerButton).toHaveCSS('border-top-width', '0px');
  await expect(deleteVisualizerButton).toHaveCSS('color', 'rgb(125, 135, 149)');
  await visualizerNode.hover();
  await expect(deleteVisualizerButton).toHaveCSS('opacity', '1');
  const inactiveMute = graph.locator('.graph-track-mute:not(:disabled)').first();
  await inactiveMute.hover();
  await expect(inactiveMute).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
  await expect(inactiveMute).toHaveCSS('border-color', 'rgb(100, 116, 135)');
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
  const grabY = handleBox.y + handleBox.height / 2;
  await page.mouse.move(handleBox.x + 35, grabY);
  await page.mouse.down();
  await page.mouse.move(handleBox.x + 79, grabY + 32, { steps: 4 });
  await page.mouse.up();
  const after = await declaration.boundingBox();
  expect(after.x).toBeGreaterThan(before.x + 30);
  expect(after.y).toBeGreaterThan(before.y + 20);
  await expect.poll(() => page.evaluate(({ sourceName }) => {
    const song = localStorage.getItem('strudel_song_name') || 'Untitled';
    const key = `strood:graph-layout:v9:${encodeURIComponent(song)}`;
    return JSON.parse(localStorage.getItem(key) || '{}')[sourceName]?.x || 0;
  }, { sourceName })).toBeGreaterThan(0);

  const sourceEditor = declaration.getByRole('textbox');
  await sourceEditor.click({ position: { x: 45, y: 24 } });
  await expect(sourceEditor).toBeFocused();
  const sizeBefore = await declaration.evaluate((element) => ({
    width: element.offsetWidth,
    height: element.offsetHeight,
  }));
  const resizeHandle = declaration.getByRole('button', { name: `Resize ${sourceName}` });
  const resizeAppearance = await resizeHandle.evaluate((element) => {
    const style = getComputedStyle(element);
    const channels = style.color.match(/[\d.]+/g)?.map(Number) || [];
    return {
      backgroundColor: style.backgroundColor,
      backgroundImage: style.backgroundImage,
      whitishLines: channels.length >= 3 && channels.slice(0, 3).every((channel) => channel > 200),
    };
  });
  expect(resizeAppearance).toEqual({
    backgroundColor: 'rgba(0, 0, 0, 0)',
    backgroundImage: 'none',
    whitishLines: true,
  });
  const resizeHandleBox = await resizeHandle.boundingBox();
  await page.mouse.move(resizeHandleBox.x + resizeHandleBox.width / 2,
    resizeHandleBox.y + resizeHandleBox.height / 2);
  await page.mouse.down();
  await page.mouse.move(resizeHandleBox.x + resizeHandleBox.width / 2 + 54,
    resizeHandleBox.y + resizeHandleBox.height / 2 + 42, { steps: 4 });
  await page.mouse.up();
  const sizeAfter = await declaration.evaluate((element) => ({
    width: element.offsetWidth,
    height: element.offsetHeight,
  }));
  expect(sizeAfter.width).toBeGreaterThan(sizeBefore.width + 20);
  expect(sizeAfter.height).toBeGreaterThan(sizeBefore.height + 20);
  await expect(sourceEditor).toBeFocused();
  await expect.poll(() => page.evaluate(({ sourceName, width, height }) => {
    const song = localStorage.getItem('strudel_song_name') || 'Untitled';
    const key = `strood:graph-layout:v9:${encodeURIComponent(song)}`;
    const layout = JSON.parse(localStorage.getItem(key) || '{}')[sourceName];
    return Boolean(layout && layout.width === width && layout.height === height);
  }, { sourceName, ...sizeAfter })).toBe(true);

  const beforeDeferredRefreshDrag = await declaration.boundingBox();
  const deferredHandle = declaration.locator('.graph-node-header');
  await deferredHandle.evaluate((element) => { element.dataset.dragRegression = 'original'; });
  const deferredHandleBox = await deferredHandle.boundingBox();
  const deferredGrabY = deferredHandleBox.y + deferredHandleBox.height / 2;
  await page.mouse.move(deferredHandleBox.x + 32, deferredGrabY);
  await page.mouse.down();
  await page.mouse.move(deferredHandleBox.x + 76, deferredGrabY + 32, { steps: 4 });
  // Blurring the focused source schedules a render after 100ms. The captured
  // node must remain attached until pointerup, then the queued render can run.
  await page.waitForTimeout(150);
  await expect(graph.locator('[data-drag-regression="original"]')).toHaveCount(1);
  await page.mouse.up();
  const afterDeferredRefreshDrag = await declaration.boundingBox();
  expect(afterDeferredRefreshDrag.x).toBeGreaterThan(beforeDeferredRefreshDrag.x + 30);
  expect(afterDeferredRefreshDrag.y).toBeGreaterThan(beforeDeferredRefreshDrag.y + 20);
  const deferredLayoutPosition = await declaration.evaluate((element) => ({
    x: element.offsetLeft,
    y: element.offsetTop,
  }));
  await expect.poll(() => page.evaluate(({ sourceName, x, y }) => {
    const song = localStorage.getItem('strudel_song_name') || 'Untitled';
    const key = `strood:graph-layout:v9:${encodeURIComponent(song)}`;
    const layout = JSON.parse(localStorage.getItem(key) || '{}')[sourceName];
    return Boolean(layout && layout.x === Math.round(x) && layout.y === Math.round(y));
  }, {
    sourceName,
    ...deferredLayoutPosition,
  })).toBe(true);

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

test('boots into responsive Code view when Graph was open last', async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem('strood:workspace-view', 'graph');
  });

  await page.goto('/');

  await expect(page.getByRole('button', { name: 'Code', exact: true }))
    .toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByRole('textbox', { name: 'Song code', exact: true })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Song graph' })).toBeHidden();
  await page.getByRole('button', { name: 'Open', exact: true }).click();
  await expect(page.getByRole('dialog', { name: 'Saved songs' })).toBeVisible();
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
  const expectedCounts = await page.evaluate(async () => {
    const { buildSongGraph } = await import('/src/graph-model.js');
    const model = buildSongGraph(localStorage.getItem('strudel_code') || '');
    return {
      nodes: model.codeNodes.length + model.visualizers.length,
      edges: model.edges.length,
    };
  });
  await expect(graph.locator('.graph-edge[data-edge-id]')).toHaveCount(expectedCounts.edges);
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
    const scale = rendered.width / Number.parseFloat(surface.style.width);
    const edgeLayer = viewport.querySelector('.graph-edges');
    const screenLaneSeparation = Number.parseFloat(
      getComputedStyle(edgeLayer).getPropertyValue('--graph-edge-render-lane-separation'),
    );
    const activeEdgeStrokeWidth = Number.parseFloat(
      getComputedStyle(edgeLayer).getPropertyValue('--graph-active-edge-render-stroke-width'),
    );
    const edgeElements = [...viewport.querySelectorAll('.graph-edge[data-edge-id]')];
    const routes = edgeElements.map((edge) => JSON.parse(edge.dataset.route || '[]'));
    const edgeOverlapPairs = [];
    const rangeOverlap = (a0, a1, b0, b1) => Math.max(
      0,
      Math.min(Math.max(a0, a1), Math.max(b0, b1))
        - Math.max(Math.min(a0, a1), Math.min(b0, b1)),
    );
    for (let left = 0; left < routes.length; left += 1) {
      for (let right = left + 1; right < routes.length; right += 1) {
        let coincident = false;
        for (let a = 1; a < routes[left].length && !coincident; a += 1) {
          const aFrom = routes[left][a - 1];
          const aTo = routes[left][a];
          const horizontal = Math.abs(aFrom.y - aTo.y) < .001;
          for (let b = 1; b < routes[right].length; b += 1) {
            const bFrom = routes[right][b - 1];
            const bTo = routes[right][b];
            if (horizontal !== (Math.abs(bFrom.y - bTo.y) < .001)) continue;
            const laneDistance = horizontal
              ? Math.abs(aFrom.y - bFrom.y)
              : Math.abs(aFrom.x - bFrom.x);
            const overlap = horizontal
              ? rangeOverlap(aFrom.x, aTo.x, bFrom.x, bTo.x)
              : rangeOverlap(aFrom.y, aTo.y, bFrom.y, bTo.y);
            if (laneDistance * scale < screenLaneSeparation && overlap * scale > 0) {
              coincident = true;
              break;
            }
          }
        }
        if (coincident) {
          edgeOverlapPairs.push([
            edgeElements[left].dataset.edgeId,
            edgeElements[right].dataset.edgeId,
          ]);
        }
      }
    }
    const masks = [...edgeLayer.querySelectorAll('defs mask')];
    const cutouts = [...edgeLayer.querySelectorAll('.graph-edge-underpass-cutout')];
    const maskedEdges = edgeElements.filter((edge) => edge.hasAttribute('mask'));
    const bridgeOverlays = [...edgeLayer.querySelectorAll('.graph-edge-bridge-overlay')];
    const maskedEdgePaths = [...edgeLayer.querySelectorAll('.graph-edge[mask]')];
    const maskIds = new Set(masks.map((mask) => mask.id));
    return {
      nodeCount: nodes.length,
      edgeCount: edgeElements.length,
      scale,
      screenLaneSeparation,
      activeEdgeStrokeWidth,
      widthFill: rendered.width / frame.width,
      heightFill: rendered.height / frame.height,
      overlapPairs,
      edgeOverlapPairs,
      bridgeCount: edgeElements.reduce(
        (count, edge) => count + Number(edge.dataset.crossings || 0),
        0,
      ),
      haloCount: edgeLayer.querySelectorAll('.graph-edge-crossing-halo').length,
      maskCount: masks.length,
      cutoutCount: cutouts.length,
      maskedEdgeCount: maskedEdges.length,
      bridgeOverlayCount: bridgeOverlays.length,
      masksAreEdgeOnly: [...edgeLayer.querySelectorAll('[mask]')]
        .every((element) => element.matches('.graph-edge')),
      maskReferencesResolve: maskedEdgePaths.every((edge) => {
        const match = edge.getAttribute('mask').match(/^url\(#(.+)\)$/);
        return match && maskIds.has(match[1]);
      }),
      bridgeOverlaysAreCurvesOnly: bridgeOverlays.every((edge) =>
        edge.getAttribute('d').includes(' C ') && !edge.getAttribute('d').includes(' L ')),
      cutoutsAreScoped: cutouts.every((cutout) => cutout.parentElement?.localName === 'mask'
        && cutout.getAttribute('stroke') === 'black'),
      backgroundIsUnmasked: !viewport.querySelector('.graph-background-canvas')?.hasAttribute('mask'),
    };
  });

  expect(metrics.nodeCount).toBe(expectedCounts.nodes);
  expect(metrics.edgeCount).toBe(expectedCounts.edges);
  expect(metrics.overlapPairs).toEqual([]);
  expect(metrics.edgeOverlapPairs).toEqual([]);
  expect(metrics.bridgeCount).toBeGreaterThan(0);
  expect(metrics.haloCount).toBe(0);
  expect(metrics.maskCount).toBeGreaterThan(0);
  expect(metrics.cutoutCount).toBeGreaterThan(0);
  expect(metrics.maskedEdgeCount).toBeGreaterThan(0);
  expect(metrics.bridgeOverlayCount).toBeGreaterThan(0);
  expect(metrics.masksAreEdgeOnly).toBe(true);
  expect(metrics.maskReferencesResolve).toBe(true);
  expect(metrics.bridgeOverlaysAreCurvesOnly).toBe(true);
  expect(metrics.cutoutsAreScoped).toBe(true);
  expect(metrics.backgroundIsUnmasked).toBe(true);
  // Below the minimum edge routing scale (.3) the app compresses screen
  // lane separation proportionally rather than re-routing.
  expect(metrics.screenLaneSeparation).toBeCloseTo(2.8 * Math.min(1, metrics.scale / .3), 1);
  expect(metrics.screenLaneSeparation).toBeGreaterThan(metrics.activeEdgeStrokeWidth);
  // The organic layout spends zoom on emergent clusters; the scale floor
  // catches blow-ups rather than enforcing grid-era density.
  expect(metrics.scale).toBeGreaterThan(.27);
  expect(metrics.widthFill).toBeGreaterThan(.9);
  expect(metrics.heightFill).toBeGreaterThan(.8);

  const viewport = graph.locator('.graph-viewport');
  const edgeRoutesBeforeZoom = await viewport.locator('.graph-edge[data-edge-id]')
    .evaluateAll((edges) => edges.map((edge) => ({
      id: edge.dataset.edgeId,
      route: edge.dataset.route,
      path: edge.getAttribute('d'),
    })));
  const scaleBeforeZoom = await graph.getAttribute('data-graph-scale');
  await viewport.dispatchEvent('wheel', {
    ctrlKey: true,
    deltaY: -60,
    clientX: 600,
    clientY: 360,
  });
  await expect.poll(() => graph.getAttribute('data-graph-scale'))
    .not.toBe(scaleBeforeZoom);
  await page.waitForTimeout(250);
  const edgeRoutesAfterZoom = await viewport.locator('.graph-edge[data-edge-id]')
    .evaluateAll((edges) => edges.map((edge) => ({
      id: edge.dataset.edgeId,
      route: edge.dataset.route,
      path: edge.getAttribute('d'),
    })));
  expect(edgeRoutesAfterZoom).toEqual(edgeRoutesBeforeZoom);
});

test('controls tracks, pause and section cues from the graph', async ({ page }) => {
  test.slow();
  const song = await fs.readFile(path.resolve(__dirname, '../../songs/kids - mgmt.strudel'), 'utf8');
  await page.addInitScript(({ code }) => {
    localStorage.setItem('strudel_code', code);
    localStorage.setItem('strudel_song_name', 'kids - mgmt');
    localStorage.setItem('strood:workspace-view', 'graph');
  }, { code: song });
  await page.goto('/');
  await page.getByRole('button', { name: 'Graph', exact: true }).click();

  const graph = page.getByRole('region', { name: 'Song graph' });
  await expect(graph.locator('.graph-section-name')).toHaveText('Opening hook');
  await page.reload();
  await page.getByRole('button', { name: 'Graph', exact: true }).click();
  await expect(graph.locator('.graph-section-name')).toHaveText('Opening hook');
  const drumTrack = graph.locator('[data-node-id="drums$"]');
  const drumArrangement = graph.locator('[data-node-id="drumsSong"]');
  await expect(drumTrack).toHaveClass(/graph-track-node/);
  await expect(drumTrack.getByRole('textbox')).toHaveValue(/drums\$:\s*track/);
  await expect(drumArrangement).toHaveClass(/graph-arrangement-node/);
  await expect(drumArrangement).not.toHaveClass(/graph-track-node/);
  await expect(graph.locator('.graph-edge[data-from="drums$"][data-to="drumsSong"]')).toHaveCount(1);
  expect(await drumArrangement.locator('.graph-arrangement-entry').evaluateAll((entries) =>
    entries.every((entry) => !entry.textContent.includes('\n')))).toBe(true);
  const hook = graph.locator('[data-node-id="hookVoice"]');
  const mute = hook.locator('.graph-track-mute');
  const solo = hook.locator('.graph-track-solo');
  await expect(mute).toHaveAttribute('aria-pressed', 'false');
  await expect(solo).toHaveAttribute('aria-pressed', 'false');

  await mute.click();
  await expect(mute).toHaveAttribute('aria-pressed', 'true');
  expect(await mute.evaluate((button) => {
    const style = getComputedStyle(button);
    return style.backgroundColor !== 'rgba(0, 0, 0, 0)'
      && style.borderColor !== 'rgba(0, 0, 0, 0)';
  })).toBe(true);
  await expect.poll(() => page.evaluate(() => localStorage.getItem('strudel_code')))
    .toContain('const hookMix = { gain: .82, pan: .48, mute: true }');
  await solo.click();
  await expect(solo).toHaveAttribute('aria-pressed', 'true');
  await expect.poll(() => page.evaluate(() => localStorage.getItem('strudel_code')))
    .toContain("const solo = 'main-hook'");

  await mute.click();
  await solo.click();
  const finalHit = graph.locator('.graph-section[data-section="Final hit"]');
  const finalDouble = graph.locator('.graph-section[data-section="Final double chorus"]');
  await finalDouble.locator('.graph-section-jump').click();
  await expect(graph.locator('.graph-section-name')).toHaveText('Final double chorus');
  await page.getByRole('button', { name: 'Play', exact: true }).click();
  await expect(page.locator('#mode')).toHaveText('PLAYING');
  await expect(graph.locator(
    '[data-node-id="danceDrums"] .graph-arrangement-entry.is-active-arrangement',
  )).toHaveCount(0);
  await expect(graph.locator('[data-node-id="danceGroove"]'))
    .not.toHaveClass(/is-arrangement-playing/);
  await expect(graph.locator('[data-node-id="mainDrums"]'))
    .toHaveClass(/is-arrangement-playing/);
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
  const currentProgress = () => graph.locator('.graph-section.is-current').evaluate((element) =>
    Number.parseFloat(element.style.getPropertyValue('--section-progress')));
  const pausedProgress = await currentProgress();
  await page.waitForTimeout(700);
  expect(Math.abs(await currentProgress() - pausedProgress)).toBeLessThan(1);

  await page.getByRole('button', { name: 'Play', exact: true }).click();
  await expect(page.locator('#mode')).toHaveText('PLAYING');
  await expect(page.getByRole('button', { name: 'Pause', exact: true })).toBeVisible();
  await expect.poll(() => page.evaluate(async () => {
    const { ensureMasterEngine } = await import('/src/audio-engine.js');
    return ensureMasterEngine().context.state;
  })).toBe('running');
  const finalHitJump = finalHit.locator('.graph-section-jump');
  await finalHitJump.click();
  await expect(finalHit).toHaveClass(/is-queued/);
  await expect.poll(() => page.evaluate(() => {
    const button = document.querySelector(
      '.graph-section[data-section="Final hit"] .graph-section-jump',
    );
    if (!button) return false;
    button.click();
    return true;
  })).toBe(true);
  await expect(graph.locator('.graph-section-name')).toHaveText('Final hit');
  const playground = graph.locator('.graph-section[data-section="Playground break"]');
  await playground.locator('.graph-section-jump').evaluate((button) => button.click());
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

  await finalDouble.locator('.graph-section-jump').dblclick();
  await expect(page.locator('#mode')).toHaveText('PLAYING');
  await expect(graph.locator('.graph-section-name')).toHaveText('Final double chorus');
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
  await page.getByRole('button', { name: 'Graph', exact: true }).click();

  const graph = page.getByRole('region', { name: 'Song graph' });
  const toggle = graph.locator('.graph-visualizers-toggle');
  const visualizerLayout = await graph.locator('.graph-visualizer-node').evaluateAll((nodes) =>
    Object.fromEntries(nodes.map((node) => [node.dataset.nodeId, {
      x: node.offsetLeft,
      y: node.offsetTop,
      width: node.offsetWidth,
      height: node.offsetHeight,
    }])));
  expect(Object.keys(visualizerLayout).length).toBeGreaterThan(0);
  await expect(toggle).toHaveAttribute('aria-label', 'Visualisers enabled');
  await expect(toggle).toHaveAttribute('aria-checked', 'true');
  await page.getByRole('button', { name: 'Play', exact: true }).click();
  await expect.poll(() => page.evaluate(() =>
    window.__stroodVisualizerRegistry?.size || 0), { timeout: 10000 }).toBeGreaterThan(0);
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-checked', 'false');
  await expect(page.locator('body')).toHaveAttribute('data-visualizers', 'off');
  await expect.poll(() => page.evaluate(() => {
    const sources = [...(window.__stroodVisualizerRegistry?.values() || [])];
    const canvases = [...document.querySelectorAll('.graph-visualizer-canvas')];
    const structure = [...document.querySelectorAll('.graph-visualizer-node, .graph-visual-edge')];
    return {
      enabled: window.__stroodVisualizersEnabled,
      visibleSources: window.__stroodGraphVisibleCanvases?.size || 0,
      sourceBuffersReleased: sources.length > 0
        && sources.every(({ canvas }) => canvas.width === 1 && canvas.height === 1),
      graphBuffersReleased: canvases.length > 0
        && canvases.every((canvas) => canvas.width === 1 && canvas.height === 1),
      graphStructureVisible: structure.length > 0
        && structure.every((element) => getComputedStyle(element).display !== 'none'),
      graphCanvasesInactive: canvases.length > 0
        && canvases.every((canvas) => getComputedStyle(canvas).opacity === '0.16'
          && getComputedStyle(canvas).filter === 'grayscale(1)'),
      inlineVisualizersHidden: [...document.querySelectorAll('.cm-content canvas[id^="_widget"]')]
        .every((element) => getComputedStyle(element).display === 'none'),
    };
  })).toEqual({
    enabled: false,
    visibleSources: 0,
    sourceBuffersReleased: true,
    graphBuffersReleased: true,
    graphStructureVisible: true,
    graphCanvasesInactive: true,
    inlineVisualizersHidden: true,
  });

  await page.getByRole('switch', { name: 'Visualisers disabled' }).click();
  await expect(page.getByRole('switch', { name: 'Visualisers enabled' }))
    .toHaveAttribute('aria-checked', 'true');
  await expect.poll(() => graph.locator('.graph-visualizer-node, .graph-visual-edge').evaluateAll(
    (elements) => elements.every((element) => getComputedStyle(element).display !== 'none'),
  )).toBe(true);
  expect(await graph.locator('.graph-visualizer-node').evaluateAll((nodes, previous) =>
    nodes.every((node) => JSON.stringify(previous[node.dataset.nodeId]) === JSON.stringify({
      x: node.offsetLeft,
      y: node.offsetTop,
      width: node.offsetWidth,
      height: node.offsetHeight,
    })), visualizerLayout)).toBe(true);
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
  await page.getByRole('button', { name: 'Graph', exact: true }).click();

  const graph = page.getByRole('region', { name: 'Song graph' });
  const opening = graph.locator('.graph-section[data-section="Opening hook"]');
  const playground = graph.locator('.graph-section[data-section="Playground break"]');
  await opening.locator('.graph-section-jump').click();
  await expect(graph.locator('.graph-section-name')).toHaveText('Opening hook');
  await page.getByRole('button', { name: 'Play', exact: true }).click();
  await expect.poll(() => graph.evaluate(() => {
    const entry = document.querySelector(
      '[data-node-id="hookSong"] .graph-arrangement-entry[data-dependency="hookClassic"]'
        + '.is-active-arrangement',
    );
    const phrase = document.querySelector('[data-node-id="hookClassic"]');
    const arrangement = document.querySelector('[data-node-id="hookSong"]');
    const track = document.querySelector('[data-node-id="hookVoice"]');
    const visualizer = document.querySelector(
      '.graph-visualizer-node[data-visualizer-target="hookVoice"]',
    );
    const edge = document.querySelector(
      '.graph-edge[data-from="hookSong"][data-to="hookClassic"].is-active-arrangement-edge',
    );
    if (!entry || !phrase || !arrangement || !track || !visualizer || !edge) return null;
    const color = phrase.style.getPropertyValue('--pattern-activity-color');
    const outlinedWithDivider = (node) => {
      const style = getComputedStyle(node);
      return node.classList.contains('is-arrangement-playing')
        && style.outlineStyle === 'solid'
        && getComputedStyle(node.querySelector('.graph-node-header')).borderBottomColor
          === style.outlineColor;
    };
    return {
      entryColor: entry.style.getPropertyValue('--arrangement-activity-color'),
      edgeColor: edge.style.getPropertyValue('--edge-activity-color'),
      phraseColor: color,
      flatEdge: getComputedStyle(edge).filter === 'none',
      phraseOutlined: outlinedWithDivider(phrase),
      arrangementOutlined: outlinedWithDivider(arrangement),
      trackOutlined: outlinedWithDivider(track),
      visualizerOutlined: visualizer.classList.contains('is-arrangement-playing')
        && getComputedStyle(visualizer).outlineStyle === 'solid'
        && getComputedStyle(visualizer).outlineColor === getComputedStyle(track).outlineColor,
    };
  }), { timeout: 5000 }).toEqual({
    entryColor: '#74f4ff',
    edgeColor: '#74f4ff',
    phraseColor: '#74f4ff',
    flatEdge: true,
    phraseOutlined: true,
    arrangementOutlined: true,
    trackOutlined: true,
    visualizerOutlined: true,
  });
  const currentProgress = () => graph.locator('.graph-section.is-current').evaluate((element) =>
    Number.parseFloat(element.style.getPropertyValue('--section-progress')));
  // The opening section is 8 cycles, so 12.5% progress means bar 2 has begun.
  await expect.poll(currentProgress, { timeout: 4000 }).toBeGreaterThanOrEqual(12.5);
  await playground.locator('.graph-section-jump').click();
  await expect(playground).toHaveClass(/is-queued/);
  const queuedProgress = await currentProgress();
  await expect.poll(async () => ({
    advanced: await currentProgress() > queuedProgress,
    section: await graph.locator('.graph-section-name').textContent(),
    queued: await playground.evaluate((element) => element.classList.contains('is-queued')),
  }), { timeout: 5000 }).toEqual({
    advanced: true,
    section: 'Opening hook',
    queued: true,
  });
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
  await page.getByRole('button', { name: 'Graph', exact: true }).click();

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
  await expect.poll(() => page.evaluate(() => localStorage.getItem('strood_song_part_v1')))
    .toContain('"Final hit"');
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
  await page.getByRole('button', { name: 'Graph', exact: true }).click();

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
  await page.getByRole('button', { name: 'Graph', exact: true }).click();

  const graph = page.getByRole('region', { name: 'Song graph' });
  const playground = graph.locator('.graph-section[data-section="Playground break"]');
  await playground.locator('.graph-section-jump').click();
  await expect(graph.locator('.graph-section-name')).toHaveText('Playground break');
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
  await page.getByRole('button', { name: 'Graph', exact: true }).click();

  const graph = page.getByRole('region', { name: 'Song graph' });
  await page.getByRole('button', { name: 'Play', exact: true }).click();
  const captureVocalOrbitRamps = () => page.evaluate(async () => {
    const { ensureMasterEngine } = await import('/src/audio-engine.js');
    const gain = ensureMasterEngine().controller.nodes[9]?.output?.gain;
    if (!gain) return false;
    const prototype = Object.getPrototypeOf(gain);
    if (!window.__stroodOriginalLinearRamp) {
      window.__stroodOriginalLinearRamp = prototype.linearRampToValueAtTime;
      prototype.linearRampToValueAtTime = function (value, time) {
        if (this === window.__stroodTrackedOrbitGain) {
          window.__stroodOrbitRampValues.push(value);
        }
        return window.__stroodOriginalLinearRamp.call(this, value, time);
      };
    }
    window.__stroodTrackedOrbitGain = gain;
    window.__stroodOrbitRampValues = [];
    return true;
  });
  await expect.poll(captureVocalOrbitRamps, { timeout: 10000 }).toBe(true);

  const vocal = graph.locator('[data-node-id="vocals"]');
  await vocal.getByRole('button', { name: /^Mute / }).click();
  await expect.poll(() => page.evaluate(() => window.__stroodOrbitRampValues))
    .toContain(0);
  await expect.poll(() => page.evaluate(() => localStorage.getItem('strudel_code')))
    .toContain('const vocalMix = { gain: .88, pan: .5, mute: true }');

  await expect.poll(captureVocalOrbitRamps, { timeout: 10000 }).toBe(true);
  await vocal.getByRole('button', { name: /^Unmute / }).click();
  await expect.poll(() => page.evaluate(() => window.__stroodOrbitRampValues))
    .toContain(1);
  await expect.poll(() => page.evaluate(() => localStorage.getItem('strudel_code')))
    .toContain('const vocalMix = { gain: .88, pan: .5, mute: false }');
  await page.evaluate(() => {
    const prototype = Object.getPrototypeOf(window.__stroodTrackedOrbitGain);
    prototype.linearRampToValueAtTime = window.__stroodOriginalLinearRamp;
    delete window.__stroodOriginalLinearRamp;
    delete window.__stroodTrackedOrbitGain;
    delete window.__stroodOrbitRampValues;
  });
  await page.getByRole('button', { name: 'Stop', exact: true }).click();
});

test('plays the selected vocal stem from the chosen song section', async ({ page }) => {
  const song = await fs.readFile(path.resolve(__dirname, '../../songs/kids - mgmt.strudel'), 'utf8');
  await page.addInitScript(({ code }) => {
    localStorage.setItem('strudel_code', code);
    localStorage.setItem('strudel_song_name', 'kids - mgmt');
    localStorage.setItem('strood:workspace-view', 'graph');
  }, { code: song });
  const vocalAsset = page.waitForResponse((response) =>
    new URL(response.url()).pathname === '/audio/kids-vocals.mp3'
      && response.status() === 200);
  await page.goto('/');
  await page.getByRole('button', { name: 'Graph', exact: true }).click();

  const graph = page.getByRole('region', { name: 'Song graph' });
  await graph.locator('[data-node-id="vocals"]')
    .getByRole('button', { name: /^Solo / }).click();
  await graph.locator('.graph-section[data-section="Verse one"] .graph-section-jump').dblclick();
  await vocalAsset;
  await expect(page.locator('#diagnostics')).toBeHidden();
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
  }), { timeout: 10000 }).toBeGreaterThan(0);
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
  await page.getByRole('button', { name: 'Graph', exact: true }).click();

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
  await expect(claviPhrase).toHaveClass(/is-arrangement-playing/);
  await expect(claviPhrase).toHaveCSS('outline-style', 'solid');
  await expect(graph.locator('.graph-pattern-activity')).toHaveCount(0);
  await expect(claviPhrase.locator('.graph-node-add-visualizer')).toHaveCount(0);
  const claviTrack = graph.locator('[data-source-name="claviVoice"]');
  await claviTrack.getByRole('button', { name: 'Add visualiser to claviVoice' }).click();
  await graph.getByRole('menuitem', { name: 'Waveform' }).click();
  await expect(page.locator('body')).not.toHaveAttribute('data-update-state', 'queued');
  const waveform = page.getByRole('article', {
    name: 'waveform visualiser connected to claviVoice',
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
    localStorage.setItem('strood_song_part_v1', JSON.stringify({ 'kids - mgmt': 'Final hit' }));
  }, { code: song });
  await page.goto('/');
  await page.getByRole('button', { name: 'Play', exact: true }).click();
  await expect(page.getByRole('status').filter({ hasText: 'PLAYING' })).toBeVisible();

  await page.getByRole('button', { name: 'Graph', exact: true }).click();
  await page.getByRole('region', { name: 'Song graph' })
    .locator('.graph-section[data-section="Playground break"] .graph-section-jump').click();
  await page.getByRole('button', { name: 'Code', exact: true }).click();
  await page.getByRole('button', { name: /Solo track, current/ }).click();
  await page.getByRole('option', { name: 'playground-tape', exact: true }).click();
  await page.getByRole('button', { name: 'Graph', exact: true }).click();

  await expect.poll(() => page.locator('[data-source-name="playgroundToys"].is-sounding').count(), {
    timeout: 5000,
  }).toBe(1);
  await expect.poll(() => page.locator('[data-source-name="playgroundToys"] .is-active-note').count())
    .toBeGreaterThan(0);
  await expect(page.locator('[aria-label*="cymatics visualiser"].is-sounding')).toHaveCount(1);
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

test('keeps patch edits made while save as is in flight', async ({ page }) => {
  const initialPatch = JSON.parse(await fs.readFile(
    path.resolve(__dirname, '../../synth-modules/patches/init.json'),
    'utf8',
  ));
  let releaseSave;
  const saveGate = new Promise((resolve) => { releaseSave = resolve; });
  let saveStarted = false;
  let listRequests = 0;
  let savedBody = null;

  await page.addInitScript(() => {
    const nativeFetch = window.fetch.bind(window);
    window.__saveAsPatchReads = 0;
    window.fetch = (input, init) => {
      const inputUrl = typeof input === 'string' ? input : input.url;
      const method = String(init?.method || input?.method || 'GET').toUpperCase();
      if (method === 'GET'
        && new URL(inputUrl, location.href).pathname === '/api/patches/save-race') {
        window.__saveAsPatchReads += 1;
      }
      return nativeFetch(input, init);
    };
  });

  await page.route('**/api/patches**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const name = decodeURIComponent(url.pathname.split('/').at(-1));
    if (request.method() === 'GET' && url.pathname === '/api/patches') {
      listRequests += 1;
      const names = listRequests === 1 ? ['init'] : ['init', 'save-race'];
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(names.map((patchName) => ({ name: patchName }))),
      });
    }
    if (request.method() === 'GET' && name === 'init') {
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(initialPatch),
      });
    }
    if (request.method() === 'PUT' && name === 'save-race') {
      saveStarted = true;
      savedBody = request.postData();
      await saveGate;
      return route.fulfill({ status: 200 });
    }
    if (request.method() === 'GET' && name === 'save-race') {
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: savedBody,
      });
    }
    return route.continue();
  });

  await page.goto('/');
  await page.getByRole('button', { name: 'Patch' }).click();
  const patch = page.getByRole('dialog', { name: 'Patch studio' });
  const frequency = patch.getByRole('slider', { name: 'filter1 frequency' });
  await expect(frequency).toBeVisible();
  await expect(patch.locator('.pe-dirty')).toHaveText('Saved');

  await patch.getByRole('button', { name: 'save as', exact: true }).click();
  const saveDialog = page.getByRole('dialog', { name: 'Save patch as' });
  await saveDialog.getByRole('textbox', { name: 'Patch name' }).fill('save-race');
  await saveDialog.getByRole('button', { name: 'Save', exact: true }).click();
  await expect.poll(() => saveStarted).toBe(true);

  const valueBeforeEdit = Number(await frequency.getAttribute('aria-valuenow'));
  await frequency.focus();
  await page.keyboard.press('ArrowRight');
  const editedValue = Number(await frequency.getAttribute('aria-valuenow'));
  expect(editedValue).toBeGreaterThan(valueBeforeEdit);
  await expect(patch.locator('.pe-dirty')).toHaveText('Unsaved');
  releaseSave();

  await expect.poll(() => listRequests).toBe(2);
  await expect(patch.getByRole('combobox', { name: 'Current synth patch' }))
    .toHaveValue('save-race');
  expect(await page.evaluate(() => window.__saveAsPatchReads)).toBe(0);
  await expect(frequency).toHaveAttribute('aria-valuenow', String(editedValue));
  await expect(patch.locator('.pe-dirty')).toHaveText('Unsaved');
});

test('keeps a patch dirty when undo wins a pending save', async ({ page }) => {
  const initialPatch = JSON.parse(await fs.readFile(
    path.resolve(__dirname, '../../synth-modules/patches/init.json'),
    'utf8',
  ));
  let releaseSave;
  const saveGate = new Promise((resolve) => { releaseSave = resolve; });
  let saveStarted = false;

  await page.route('**/api/patches**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (request.method() === 'GET' && url.pathname === '/api/patches') {
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify([{ name: 'init' }]),
      });
    }
    if (request.method() === 'GET' && url.pathname === '/api/patches/init') {
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(initialPatch),
      });
    }
    if (request.method() === 'PUT' && url.pathname === '/api/patches/init') {
      saveStarted = true;
      await saveGate;
      return route.fulfill({ status: 200 });
    }
    return route.continue();
  });

  await page.goto('/');
  await page.getByRole('button', { name: 'Patch' }).click();
  const patch = page.getByRole('dialog', { name: 'Patch studio' });
  const frequency = patch.getByRole('slider', { name: 'filter1 frequency' });
  await expect(frequency).toBeVisible();
  const initialValue = await frequency.getAttribute('aria-valuenow');

  await frequency.focus();
  await page.keyboard.press('ArrowRight');
  await expect(frequency).not.toHaveAttribute('aria-valuenow', initialValue);
  const undo = patch.getByRole('button', { name: 'undo', exact: true });
  await expect(undo).toBeEnabled();
  await patch.getByRole('button', { name: 'save', exact: true }).click();
  await expect.poll(() => saveStarted).toBe(true);

  await undo.click();
  await expect(frequency).toHaveAttribute('aria-valuenow', initialValue);
  await expect(patch.locator('.pe-dirty')).toHaveText('Unsaved');
  releaseSave();

  await expect(page.getByText('Saved patch init', { exact: true })).toBeVisible();
  await expect(frequency).toHaveAttribute('aria-valuenow', initialValue);
  await expect(patch.locator('.pe-dirty')).toHaveText('Unsaved');
});

test('rechecks patch edits made while another patch is loading', async ({ page }) => {
  const initialPatch = JSON.parse(await fs.readFile(
    path.resolve(__dirname, '../../synth-modules/patches/init.json'),
    'utf8',
  ));
  const otherPatch = JSON.parse(await fs.readFile(
    path.resolve(__dirname, '../../synth-modules/patches/vox-pad.json'),
    'utf8',
  ));
  let releaseLoad;
  const loadGate = new Promise((resolve) => { releaseLoad = resolve; });
  let loadStarted = false;

  await page.route('**/api/patches**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (request.method() === 'GET' && url.pathname === '/api/patches') {
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify([{ name: 'init' }, { name: 'vox-pad' }]),
      });
    }
    if (request.method() === 'GET' && url.pathname === '/api/patches/init') {
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(initialPatch),
      });
    }
    if (request.method() === 'GET' && url.pathname === '/api/patches/vox-pad') {
      loadStarted = true;
      await loadGate;
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(otherPatch),
      });
    }
    return route.continue();
  });

  await page.goto('/');
  await page.getByRole('button', { name: 'Patch' }).click();
  const patch = page.getByRole('dialog', { name: 'Patch studio' });
  const selector = patch.getByRole('combobox', { name: 'Current synth patch' });
  const frequency = patch.getByRole('slider', { name: 'filter1 frequency' });
  await expect(frequency).toBeVisible();

  await selector.selectOption('vox-pad');
  await expect.poll(() => loadStarted).toBe(true);
  await frequency.focus();
  await page.keyboard.press('ArrowRight');
  const editedValue = await frequency.getAttribute('aria-valuenow');
  await expect(patch.locator('.pe-dirty')).toHaveText('Unsaved');
  releaseLoad();

  const discard = page.getByRole('dialog', { name: 'Discard patch changes?' });
  await expect(discard).toBeVisible();
  await discard.getByRole('button', { name: 'Cancel' }).click();
  await expect(selector).toHaveValue('init');
  await expect(frequency).toHaveAttribute('aria-valuenow', editedValue);
  await expect(patch.locator('.pe-dirty')).toHaveText('Unsaved');
});

test('shows the exact unsaved source changes before switching songs', async ({ page }) => {
  await page.goto('/');
  const editor = page.getByRole('textbox', { name: 'Song code', exact: true });
  await editor.click();
  await page.keyboard.press('Control+Home');
  await page.keyboard.insertText('// unsaved review check');

  const unsaved = page.getByRole('button', { name: 'Unsaved', exact: true });
  await expect(unsaved).toBeVisible();
  await unsaved.click();
  const directReview = page.locator('.app-dialog[aria-label^="Unsaved changes ·"]');
  await expect(directReview).toBeVisible();
  await expect(directReview.locator('.unsaved-diff-row.add .unsaved-diff-code')
    .filter({ hasText: '// unsaved review check' })).toBeVisible();
  await directReview.getByRole('button', { name: 'Close' }).click();

  await page.getByRole('button', { name: 'Open' }).click();
  const browser = page.getByRole('dialog', { name: 'Saved songs' });
  await browser.locator('.song-row .song-name').first().click();
  const warning = page.getByRole('dialog', { name: 'Unsaved changes', exact: true });
  await expect(warning.getByRole('button', { name: 'See changes' })).toBeVisible();
  await warning.getByRole('button', { name: 'See changes' }).click();
  const switchReview = page.locator('.app-dialog[aria-label^="Unsaved changes ·"]');
  await expect(switchReview.locator('.unsaved-diff-row.add .unsaved-diff-code')
    .filter({ hasText: '// unsaved review check' })).toBeVisible();
  await switchReview.getByRole('button', { name: 'Back' }).click();
  await page.getByRole('dialog', { name: 'Unsaved changes', exact: true })
    .getByRole('button', { name: 'Cancel' }).click();
  await browser.getByRole('button', { name: 'Close' }).click();
  await editor.click();
  await page.keyboard.press('ControlOrMeta+Z');
  await expect(page.locator('#save-state')).toBeHidden();
  await expect(page.locator('#dirty-count')).toBeEmpty();
});

test('recovers the default song when a deleted cached song left a blank buffer', async ({ page }) => {
  const fallbackCode = 'const recoveredDefault = true';
  const requestedSongs = [];

  await page.addInitScript(() => {
    localStorage.setItem('strudel_code', '');
    localStorage.setItem('strudel_song_name', 'deleted startup song');
  });
  await page.route('**/api/songs/**', async (route) => {
    const name = decodeURIComponent(new URL(route.request().url()).pathname.split('/').at(-1));
    requestedSongs.push(name);
    if (name === 'deleted startup song') {
      return route.fulfill({ status: 404, body: 'Song not found' });
    }
    if (name === 'ms jackson') {
      return route.fulfill({
        status: 200,
        body: fallbackCode,
        headers: { 'Content-Type': 'text/plain', ETag: '"fallback-version"' },
      });
    }
    return route.continue();
  });

  await page.goto('/');

  await expect(page.locator('#song-name')).toHaveText('ms jackson');
  await expect(page.getByRole('textbox', { name: 'Song code', exact: true }))
    .toContainText(fallbackCode);
  expect(requestedSongs).toEqual(['deleted startup song', 'ms jackson']);
  await expect.poll(() => page.evaluate(() => localStorage.getItem('strudel_song_name')))
    .toBe('ms jackson');
});

test('preserves non-empty code when its cached song was deleted', async ({ page }) => {
  const draftCode = 'const unsavedDraft = true';
  let fallbackRequested = false;

  await page.addInitScript(({ code }) => {
    localStorage.setItem('strudel_code', code);
    localStorage.setItem('strudel_song_name', 'deleted startup song');
  }, { code: draftCode });
  await page.route('**/api/songs/**', async (route) => {
    const name = decodeURIComponent(new URL(route.request().url()).pathname.split('/').at(-1));
    if (name === 'deleted startup song') {
      return route.fulfill({ status: 404, body: 'Song not found' });
    }
    if (name === 'ms jackson') fallbackRequested = true;
    return route.continue();
  });

  await page.goto('/');

  await expect(page.locator('#song-name')).toHaveText('Untitled');
  await expect(page.getByRole('textbox', { name: 'Song code', exact: true }))
    .toContainText(draftCode);
  expect(fallbackRequested).toBe(false);
  await expect.poll(() => page.evaluate(() => localStorage.getItem('strudel_song_name')))
    .toBeNull();
});

test('waits for startup identity before saving an early edit', async ({ page }) => {
  const initialCode = 'const startupValue = 1';
  const diskCode = 'const startupValue = 2';
  const diskVersion = '"startup-version"';
  let releaseStartup;
  const startupGate = new Promise((resolve) => { releaseStartup = resolve; });
  let savedRequest = null;

  await page.addInitScript(({ code }) => {
    localStorage.setItem('strudel_code', code);
    localStorage.setItem('strudel_song_name', 'ms jackson');
  }, { code: initialCode });
  await page.route('**/api/songs/**', async (route) => {
    const request = route.request();
    const name = decodeURIComponent(new URL(request.url()).pathname.split('/').at(-1));
    if (name !== 'ms jackson') return route.continue();
    if (request.method() === 'GET') {
      await startupGate;
      return route.fulfill({
        status: 200,
        body: diskCode,
        headers: { 'Content-Type': 'text/plain', ETag: diskVersion },
      });
    }
    if (request.method() === 'PUT') {
      savedRequest = {
        body: request.postData(),
        version: request.headers()['if-match'],
      };
      return route.fulfill({ status: 200, headers: { ETag: '"saved-version"' } });
    }
    return route.continue();
  });

  await page.goto('/');
  const editor = page.getByRole('textbox', { name: 'Song code', exact: true });
  await editor.click();
  await page.keyboard.press('Control+End');
  await page.keyboard.insertText('\n// typed before startup finished');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByRole('dialog', { name: 'Save song' })).toHaveCount(0);

  releaseStartup();
  await expect.poll(() => savedRequest).not.toBeNull();
  expect(savedRequest).toEqual({
    body: `${initialCode}\n// typed before startup finished`,
    version: diskVersion,
  });
  await expect(page.locator('#save-state')).toBeHidden();
});

test('keeps an opened song when an older startup request fails', async ({ page }) => {
  const startupCode = 'const staleStartup = true';
  const openedCode = 'const openedSong = true';
  const openedVersion = '"opened-version"';
  let releaseStartup;
  const startupGate = new Promise((resolve) => { releaseStartup = resolve; });
  let savedRequest = null;

  await page.addInitScript(({ code }) => {
    localStorage.setItem('strudel_code', code);
    localStorage.setItem('strudel_song_name', 'slow startup');
  }, { code: startupCode });
  await page.route('**/api/songs**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const name = decodeURIComponent(url.pathname.split('/').at(-1));
    if (request.method() === 'GET' && url.pathname === '/api/songs') {
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify([{ name: 'kids - mgmt', mtime: Date.now() }]),
      });
    }
    if (request.method() === 'GET' && name === 'slow startup') {
      await startupGate;
      return route.fulfill({ status: 500, body: 'delayed startup failure' });
    }
    if (request.method() === 'GET' && name === 'kids - mgmt') {
      return route.fulfill({
        status: 200,
        body: openedCode,
        headers: { 'Content-Type': 'text/plain', ETag: openedVersion },
      });
    }
    if (request.method() === 'PUT' && name === 'kids - mgmt') {
      savedRequest = {
        body: request.postData(),
        version: request.headers()['if-match'],
      };
      return route.fulfill({ status: 200, headers: { ETag: '"saved-version"' } });
    }
    return route.continue();
  });

  await page.goto('/');
  await page.getByRole('button', { name: 'Open' }).click();
  await page.getByRole('dialog', { name: 'Saved songs' })
    .getByRole('button', { name: 'kids - mgmt', exact: true }).click();
  await expect(page.locator('#song-name')).toHaveText('kids - mgmt');

  const editor = page.getByRole('textbox', { name: 'Song code', exact: true });
  await editor.click();
  await page.keyboard.press('Control+End');
  await page.keyboard.insertText('\n// edit after open');
  releaseStartup();
  await page.getByRole('button', { name: 'Save', exact: true }).click();

  await expect(page.getByRole('dialog', { name: 'Save song' })).toHaveCount(0);
  await expect.poll(() => savedRequest).toEqual({
    body: `${openedCode}\n// edit after open`,
    version: openedVersion,
  });
  await expect(page.locator('#song-name')).toHaveText('kids - mgmt');
  await expect(page.locator('#diagnostics')).toBeHidden();
});

test('keeps a new buffer untitled when an older startup request succeeds', async ({ page }) => {
  const displayedCode = 'const startupBuffer = true';
  let releaseStartup;
  const startupGate = new Promise((resolve) => { releaseStartup = resolve; });
  let saveRequested = false;

  await page.addInitScript(({ code }) => {
    localStorage.setItem('strudel_code', code);
    localStorage.setItem('strudel_song_name', 'old song');
  }, { code: displayedCode });
  await page.route('**/api/songs/old%20song', async (route) => {
    if (route.request().method() === 'GET') {
      await startupGate;
      return route.fulfill({
        status: 200,
        body: 'const diskCopy = true',
        headers: { 'Content-Type': 'text/plain', ETag: '"old-version"' },
      });
    }
    saveRequested = true;
    return route.fulfill({ status: 200, headers: { ETag: '"unexpected-save"' } });
  });

  await page.goto('/');
  await page.getByRole('button', { name: 'New' }).click();
  await expect(page.locator('#song-name')).toHaveText('Untitled');
  releaseStartup();
  await page.getByRole('button', { name: 'Save', exact: true }).click();

  await expect(page.getByRole('dialog', { name: 'Save song' })).toBeVisible();
  await expect(page.locator('#song-name')).toHaveText('Untitled');
  expect(saveRequested).toBe(false);
  await page.getByRole('dialog', { name: 'Save song' })
    .getByRole('button', { name: 'Cancel' }).click();
});

test('stop button cancels an update waiting for sample preparation', async ({ page }) => {
  const initialCode = 'note("c4").sound("sine")';
  let releaseSample;
  const sampleGate = new Promise((resolve) => { releaseSample = resolve; });
  let sampleRequested = false;

  await page.addInitScript(({ code }) => {
    localStorage.setItem('strudel_code', code);
    localStorage.setItem('strudel_song_name', 'ms jackson');
  }, { code: initialCode });
  await page.route('**/api/songs/ms%20jackson', (route) => route.fulfill({
    status: 200,
    body: initialCode,
    headers: { 'Content-Type': 'text/plain', ETag: '"stop-race-version"' },
  }));
  await page.route('**/audio/stop-race.mp3', async (route) => {
    sampleRequested = true;
    await sampleGate;
    await route.fulfill({ status: 404, body: '' });
  });

  await page.goto('/');
  await page.getByRole('button', { name: 'Play', exact: true }).click();
  await expect(page.locator('#mode')).toHaveText('PLAYING');
  const editors = page.locator('#editors-container');
  await expect(editors).toHaveAttribute('data-evaluated-length', String(initialCode.length));
  const evaluatedLength = await editors.getAttribute('data-evaluated-length');

  const editor = page.getByRole('textbox', { name: 'Song code', exact: true });
  await editor.click();
  await page.keyboard.press('Control+Home');
  await page.keyboard.insertText("const delayedSample = '/audio/stop-race.mp3'\n");
  await page.getByRole('button', { name: 'Update', exact: true }).click();
  await expect.poll(() => sampleRequested, { timeout: 10000 }).toBe(true);
  await expect(page.locator('body')).toHaveAttribute('data-update-state', 'applying');

  await page.getByRole('button', { name: 'Stop', exact: true }).click();
  await expect(page.locator('#mode')).toHaveText('STOPPED');
  releaseSample();

  await expect(page.locator('body')).toHaveAttribute('data-update-state', '');
  await expect(page.locator('#mode')).toHaveText('STOPPED');
  await expect(editors).toHaveAttribute('data-evaluated-length', evaluatedLength);
});

test('applies a pending disk update after undo returns to clean', async ({ page }) => {
  await page.goto('/');
  const editor = page.getByRole('textbox', { name: 'Song code', exact: true });
  const savedCode = await page.evaluate(() => localStorage.getItem('strudel_code'));
  const externalCode = `${savedCode}\n// external update after undo`;

  await editor.click();
  await page.keyboard.press('Control+Home');
  await page.keyboard.insertText('// temporary local edit\n');
  await page.evaluate(async ({ code }) => {
    const { createHotContext } = await import('/@vite/client');
    const hot = createHotContext('/tests/e2e/pending-external-update');
    await hot.hmrClient.notifyListeners('strudel:update', {
      name: 'ms jackson',
      code,
      version: '"external-version"',
    });
  }, { code: externalCode });
  await expect(page.locator('#save-state')).toHaveText('File changed on disk');

  await page.keyboard.press('ControlOrMeta+Z');
  await expect.poll(() => page.evaluate(() => localStorage.getItem('strudel_code')))
    .toBe(externalCode);
  await expect(editor).toHaveAttribute('data-document-length', String(externalCode.length));
  await expect.poll(() => page.evaluate(() =>
    document.querySelector('.cm-content')?.cmTile?.root?.view?.state.doc.toString()))
    .toBe(externalCode);
  await expect(page.locator('#save-state')).toBeHidden();
  await expect(page.locator('#dirty-count')).toBeEmpty();
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
  await page.addInitScript(() => {
    localStorage.setItem(`strood:graph-layout:v9:${encodeURIComponent('ms jackson')}`, JSON.stringify({
      'visualizer:leadVocal:_spiral:0': { x: 18, y: 1000 },
      'visualizer:bassLine:_scope:0': { x: 900, y: 1000 },
      'visualizer:organChords:_lissajous:0': { x: 1800, y: 1000 },
      'visualizer:hatsPattern:_orbit:0': { x: 2700, y: 1000 },
    }));
    window.__stroodCanvasWork = { mirrors: {}, sources: {} };
    const increment = (bucket, key) => {
      if (key) bucket[key] = (bucket[key] || 0) + 1;
    };
    const drawImage = CanvasRenderingContext2D.prototype.drawImage;
    CanvasRenderingContext2D.prototype.drawImage = function (...args) {
      if (this.canvas?.classList?.contains('graph-visualizer-canvas')) {
        increment(
          window.__stroodCanvasWork.mirrors,
          this.canvas.closest('.graph-visualizer-node')?.dataset.nodeId,
        );
      }
      return drawImage.apply(this, args);
    };
    const clearRect = CanvasRenderingContext2D.prototype.clearRect;
    CanvasRenderingContext2D.prototype.clearRect = function (...args) {
      const sourceId = this.canvas?.dataset.visualizerMethod ? this.canvas.id : null;
      increment(window.__stroodCanvasWork.sources, sourceId);
      return clearRect.apply(this, args);
    };
  });
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

  const viewport = page.locator('.graph-viewport');
  await expect.poll(() => viewport.locator('.graph-edge[data-edge-id]').evaluateAll((edges) =>
    edges.length > 0 && edges.every((edge) => Boolean(edge.getAttribute('d'))))).toBe(true);
  const initialGraphState = await viewport.evaluate((element) => {
    const visualizer = element.querySelector('.graph-visualizer-node');
    return {
      anchorId: visualizer.dataset.nodeId,
      anchorLeft: visualizer.getBoundingClientRect().left,
      edgePaths: [...element.querySelectorAll('.graph-edge[data-edge-id]')]
        .map((edge) => edge.getAttribute('d')),
    };
  });
  await viewport.dispatchEvent('wheel', {
    deltaX: 10000,
    deltaY: 0,
    bubbles: true,
    cancelable: true,
  });
  await expect.poll(() => viewport.evaluate((element) =>
    !element.classList.contains('is-camera-moving'))).toBe(true);

  const readGraphVisibility = () => page.evaluate(() => {
    const frame = document.querySelector('.graph-viewport').getBoundingClientRect();
    const registry = [...(window.__stroodVisualizerRegistry?.values() || [])];
    const byMethod = new Map();
    for (const entry of registry) {
      const entries = byMethod.get(entry.method) || [];
      entries.push(entry);
      byMethod.set(entry.method, entries);
    }
    const visibleNodeIds = [];
    const expectedSourceIds = [];
    const culledNodeIds = [];
    const culledSourceIds = [];
    const culledMethods = [];
    for (const node of document.querySelectorAll('.graph-visualizer-node')) {
      const rect = node.getBoundingClientRect();
      const visible = rect.right >= frame.left - 140
        && rect.left <= frame.right + 140
        && rect.bottom >= frame.top - 140
        && rect.top <= frame.bottom + 140;
      const source = byMethod.get(node.dataset.method)?.[Number(node.dataset.methodIndex)];
      if (visible) {
        visibleNodeIds.push(node.dataset.nodeId);
        if (source) expectedSourceIds.push(source.id);
      } else {
        culledNodeIds.push(node.dataset.nodeId);
        if (source) culledSourceIds.push(source.id);
        culledMethods.push(node.dataset.method);
      }
    }
    const activeSourceIds = registry
      .filter(({ canvas }) => window.__stroodGraphVisibleCanvases?.has(canvas))
      .map(({ id }) => id)
      .sort();
    expectedSourceIds.sort();
    return {
      activeSourceIds,
      expectedSourceIds,
      visibleNodeIds,
      culledNodeIds,
      culledSourceIds,
      culledMethods,
      total: registry.length,
      settled: expectedSourceIds.length > 0
        && expectedSourceIds.length < registry.length
        && JSON.stringify(activeSourceIds) === JSON.stringify(expectedSourceIds),
    };
  });
  await expect.poll(async () => (await readGraphVisibility()).settled).toBe(true);
  const visibility = await readGraphVisibility();
  expect(visibility.total).toBe(4);
  expect(visibility.culledMethods).toContain('_spiral');

  await page.evaluate(() => new Promise((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(resolve));
  }));
  const workBefore = await page.evaluate(() => structuredClone(window.__stroodCanvasWork));
  const liveMirror = visibility.visibleNodeIds[0];
  await expect.poll(() => page.evaluate(({ nodeId, before }) =>
    (window.__stroodCanvasWork.mirrors[nodeId] || 0) - (before.mirrors[nodeId] || 0), {
    nodeId: liveMirror,
    before: workBefore,
  })).toBeGreaterThanOrEqual(1);
  await expect.poll(() => page.evaluate(({ ids, before }) => ids.every((id) =>
    (window.__stroodCanvasWork.sources[id] || 0) > (before.sources[id] || 0)), {
    ids: visibility.expectedSourceIds,
    before: workBefore,
  })).toBe(true);
  const workAfter = await page.evaluate(() => structuredClone(window.__stroodCanvasWork));
  for (const nodeId of visibility.culledNodeIds) {
    expect(workAfter.mirrors[nodeId] || 0).toBe(workBefore.mirrors[nodeId] || 0);
  }
  for (const sourceId of visibility.culledSourceIds) {
    expect(workAfter.sources[sourceId] || 0).toBe(workBefore.sources[sourceId] || 0);
  }
  expect(await viewport.locator('.graph-edge[data-edge-id]').evaluateAll((edges) =>
    edges.map((edge) => edge.getAttribute('d')))).toEqual(initialGraphState.edgePaths);

  const restoreDelta = await viewport.evaluate((element, initial) => {
    const anchor = element.querySelector(`[data-node-id="${CSS.escape(initial.anchorId)}"]`);
    return anchor.getBoundingClientRect().left - initial.anchorLeft;
  }, initialGraphState);
  await viewport.dispatchEvent('wheel', {
    deltaX: restoreDelta,
    deltaY: 0,
    bubbles: true,
    cancelable: true,
  });
  await expect.poll(() => page.evaluate(() => window.__stroodGraphVisibleCanvases?.size || 0))
    .toBe(4);
  await expect.poll(() => page.evaluate(({ nodeIds, sourceIds, before }) => ({
    mirrors: nodeIds.every((id) =>
      (window.__stroodCanvasWork.mirrors[id] || 0) > (before.mirrors[id] || 0)),
    sources: sourceIds.every((id) =>
      (window.__stroodCanvasWork.sources[id] || 0) > (before.sources[id] || 0)),
  }), {
    nodeIds: visibility.culledNodeIds,
    sourceIds: visibility.culledSourceIds,
    before: workAfter,
  })).toEqual({ mirrors: true, sources: true });
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
  await expect.poll(() => page.evaluate(async () => {
    const { ensureMasterEngine } = await import('/src/audio-engine.js');
    return ensureMasterEngine().context.state;
  }), { timeout: 15000 }).toBe('running');
  const outputSafety = await page.evaluate(async () => {
    const { ensureMasterEngine } = await import('/src/audio-engine.js');
    const engine = ensureMasterEngine();
    const settings = (node) => ({
      threshold: node.threshold.value,
      knee: node.knee.value,
      ratio: node.ratio.value,
      attack: node.attack.value,
      release: node.release.value,
    });
    return {
      sourceConnected: engine.source === engine.controller.output.destinationGain,
      masterGain: engine.masterGain.gain.value,
      compressor: settings(engine.compressor),
      limiter: settings(engine.limiter),
      analyser: {
        fftSize: engine.analyser.fftSize,
        smoothingTimeConstant: engine.analyser.smoothingTimeConstant,
      },
    };
  });
  expect(outputSafety).toEqual({
    sourceConnected: true,
    masterGain: 1,
    compressor: {
      threshold: -14,
      knee: 10,
      ratio: 3,
      attack: expect.closeTo(0.015, 5),
      release: expect.closeTo(0.18, 5),
    },
    limiter: {
      threshold: -1,
      knee: 0,
      ratio: 20,
      attack: expect.closeTo(0.002, 5),
      release: expect.closeTo(0.06, 5),
    },
    analyser: {
      fftSize: 1024,
      smoothingTimeConstant: expect.closeTo(0.72, 5),
    },
  });
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
  const songsPath = path.resolve(__dirname, '../../songs');
  const songPath = path.join(songsPath, `${name}.strudel`);
  const historyPath = path.join(
    songsPath,
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

test('labels malformed JSON requests without reporting a server failure', async ({ request }) => {
  const headers = { 'Content-Type': 'application/json' };
  const rename = await request.post('/api/songs/ms%20jackson/rename', {
    data: Buffer.from('{'),
    headers,
  });
  expect(rename.status()).toBe(400);
  await expect(rename.json()).resolves.toMatchObject({ code: 'invalid_json' });

  const patch = await request.put('/api/patches/init', {
    data: Buffer.from('{'),
    headers,
  });
  expect(patch.status()).toBe(400);
  await expect(patch.json()).resolves.toMatchObject({ code: 'invalid_json' });
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
  await expect.poll(async () => {
    const mark = page.locator(
      '.cm-content span[style*="background"][style*="box-shadow: none"]',
    ).first();
    return await mark.count() ? mark.evaluate((element) => getComputedStyle(element).color) : null;
  }, { timeout: 10000 }).toBe('rgb(255, 255, 255)');
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

test('magnifies the graph under a shift-held lens with anchored optics', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Graph' }).click();
  const graph = page.getByRole('region', { name: 'Song graph' });
  await expect(graph.locator('.graph-declaration-node').first()).toBeVisible();

  const lens = graph.locator('.graph-lens');
  await expect(lens).toBeHidden();
  await graph.locator('.graph-declaration-node').first().hover();
  await page.keyboard.down('Shift');
  await expect(lens).toBeVisible();
  expect(await graph.locator('.graph-declaration-node').first()
    .evaluate((node) => getComputedStyle(node).cursor)).toBe('none');
  await expect(lens.locator('.graph-lens-world-main .graph-node').first()).toBeAttached();
  await expect.poll(() => page.evaluate(() => {
    const parse = (value) => Number((value.match(/scale\(([\d.]+)\)/) || [])[1]);
    const surface = parse(document.querySelector('.graph-surface').style.transform || 'scale(1)');
    const main = parse(document.querySelector('.graph-lens-world-main').style.transform || '');
    const red = parse(document.querySelector('.graph-lens-ca-red .graph-lens-world').style.transform || '');
    const blue = parse(document.querySelector('.graph-lens-ca-blue .graph-lens-world').style.transform || '');
    return { magnified: main > surface * 2, aberration: red > main && blue < main };
  })).toEqual({ magnified: true, aberration: true });
  await page.keyboard.up('Shift');
  await expect(lens).toBeHidden();

  const source = graph.locator('.graph-declaration-node').first().getByRole('textbox');
  await source.click();
  await page.keyboard.down('Shift');
  await expect(lens).toBeHidden();
  await page.keyboard.up('Shift');
});

test('re-layouts the graph, discarding saved node positions', async ({ page }) => {
  const song = await fs.readFile(path.resolve(__dirname, '../../songs/kids - mgmt.strudel'), 'utf8');
  await page.addInitScript(({ code }) => {
    localStorage.setItem('strudel_code', code);
    localStorage.setItem('strudel_song_name', 'kids - mgmt');
    localStorage.setItem('strood:workspace-view', 'graph');
    localStorage.setItem('strood:graph-layout:v9:kids%20-%20mgmt', JSON.stringify({
      hookVoice: { x: 4200, y: 3200, width: 190, height: 140 },
    }));
  }, { code: song });
  await page.goto('/');
  await page.getByRole('button', { name: 'Graph', exact: true }).click();

  const graph = page.getByRole('region', { name: 'Song graph' });
  const hook = graph.locator('[data-node-id="hookVoice"]');
  await expect(hook).toBeVisible();
  expect(await hook.evaluate((node) => node.offsetLeft)).toBeGreaterThan(4000);

  await graph.getByRole('button', { name: 'Re-layout graph nodes' }).click();
  await expect.poll(() => hook.evaluate((node) => node.offsetLeft)).toBeLessThan(4000);
  // The organic layout keeps connected nodes near each other: the hook chain
  // edges must be far shorter than the drawing itself.
  const spans = await graph.evaluate((root) => {
    const centreOf = (id) => {
      const node = root.querySelector(`[data-node-id="${id}"]`);
      return { x: node.offsetLeft + node.offsetWidth / 2, y: node.offsetTop + node.offsetHeight / 2 };
    };
    const between = (a, b) => Math.hypot(centreOf(a).x - centreOf(b).x, centreOf(a).y - centreOf(b).y);
    const nodes = [...root.querySelectorAll('.graph-node[data-node-id]')];
    const width = Math.max(...nodes.map((node) => node.offsetLeft + node.offsetWidth));
    return {
      width,
      songToPhrase: between('hookSong', 'hookClassic'),
      voiceToSong: between('hookVoice', 'hookSong'),
    };
  });
  expect(spans.songToPhrase).toBeLessThan(spans.width / 3);
  expect(spans.voiceToSong).toBeLessThan(spans.width / 3);
});
