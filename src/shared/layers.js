// Designer layer model + renderer registry. Mirrors the observed original
// architecture: one renderer per layer type, per-shape arm/dot renderers.
// Coordinate space: centered at (0,0), +X right, +Y up (original semantics).
// Pure functions; dual export (main CJS / renderer classic script / tests).
// Reimplemented from scratch — no original code copied.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.CQLayers = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  let idCounter = 0;
  function uid() {
    return 'ly_' + Date.now().toString(36) + '_' + (++idCounter).toString(36);
  }

  function num(v) {
    const n = Number(v);
    if (!isFinite(n)) return '0';
    const s = Math.round(n * 1e6) / 1e6;
    return Object.is(s, -0) ? '0' : String(s);
  }
  // Sanitize a layer id for use as an HTML/SVG id attribute and selector.
  // ponytail: per-element opacity not yet encoded; this only hardens id reuse.
  function sanitizeId(value) {
    const cleaned = String(value ?? '').replace(/[^A-Za-z0-9_-]/g, '-').replace(/^-+|-+$/g, '');
    return (cleaned || 'layer').slice(0, 128);
  }

  function newModelLayer() {
    return {
      id: uid(), type: 'model', name: 'Mira', visible: true,
      x: 0, y: 0, scale: 1, rotation: 0, opacity: 1,
      armCount: 4, armSpacing: 14, armLength: 0, armThickness: 0,
      armShape: 'rect', armColor: '#ffffff', armRotation: 0, armBlur: 0,
      gap: 14, armLen: 0, armThick: 0,
      dot: { enabled: true, shape: 'circle', size: 4, color: '#ffffff', blur: 0 },
      outline: { enabled: true, width: 1, color: '#000000', blur: 0 },
    };
  }

  function newShapeLayer() {
    return {
      id: uid(), type: 'shape', name: 'Forma', visible: true,
      shape: 'rect', x: 0, y: 0, w: 20, h: 20, rotation: 0, opacity: 1,
      fill: '#ffffff', stroke: { enabled: true, color: '#000000', width: 1 },
    };
  }

  function newTextLayer() {
    return {
      id: uid(), type: 'text', name: 'Texto', visible: true,
      text: 'CQ', x: 0, y: 0, fontSize: 16, fontFamily: 'sans-serif',
      bold: true, italic: false, color: '#ffffff', rotation: 0, opacity: 1,
    };
  }

  function newImageLayer(src, w, h) {
    return {
      id: uid(), type: 'image', name: 'Imagem', visible: true,
      src, x: 0, y: 0, w, h, rotation: 0, opacity: 1,
    };
  }

  function newDrawLayer(src, w, h) {
    return {
      id: uid(), type: 'draw', name: 'Desenho', visible: true,
      x: 0, y: 0, size: 1, opacity: 1, rotation: 0,
      src, w: w || 0, h: h || 0,
    };
  }

  const armRenderers = {
    rect(a) {
      const { w, h } = a;
      const op = a.alpha != null ? ` opacity="${num(a.alpha)}"` : '';
      return `<rect x="${-w / 2}" y="${-h / 2}" width="${w}" height="${h}"${op}/>`;
    },
    triangle(a) {
      const { w, h } = a;
      const op = a.alpha != null ? ` opacity="${num(a.alpha)}"` : '';
      return `<polygon points="${w / 2},0 ${-w / 2},${-h / 2} ${-w / 2},${h / 2}"${op}/>`;
    },
    chevron(a) {
      const { w, h } = a;
      const op = a.alpha != null ? ` opacity="${num(a.alpha)}"` : '';
      return `<polygon points="${-w / 2},${-h / 2} ${w / 2},0 ${-w / 2},${h / 2} ${-w / 2 + w * 0.45},0"${op}/>`;
    },
  };

  const dotRenderers = {
    circle(r) {
      return `<circle cx="0" cy="0" r="${num(r)}"/>`;
    },
    square(r) {
      return `<rect x="${-r}" y="${-r}" width="${r * 2}" height="${r * 2}"/>`;
    },
    diamond(r) {
      return `<polygon points="0,${-r} ${r},0 0,${r} ${-r},0"/>`;
    },
    ring(r) {
      return `<circle cx="0" cy="0" r="${num(r)}" fill="none"/>`;
    },
  };

  function strokeAttr(l) {
    return l.outline?.enabled || l.stroke?.enabled
      ? ` stroke="${escapeXml((l.outline || l.stroke).color)}" stroke-width="${num((l.outline || l.stroke).width)}"`
      : '';
  }

  function layerBounds(l) {
    if (!l) return { w: 20, h: 20 };
    // Compatibility contract: Designer reuses these dimensions as intrinsic
    // resize inputs. Box/text types must not bake scale, stroke or rotation in.
    // Selection paint bounds need a separate DOM measurement in the consumer.
    if (['shape', 'image', 'draw'].includes(l.type)) return { w: l.w || 4, h: l.h || 4 };
    if (l.type === 'text') {
      const fs = l.fontSize ?? 16;
      const len = String(l.text || '').length || 1;
      return { w: Math.max(8, fs * len * 0.62), h: fs * 1.4 + 4 };
    }
    if (l.type !== 'model') return { w: 20, h: 20 };
    const scale = l.scale ?? 1;
    const points = [];
    const rotation = (l.type === 'model' ? 1 : -1) * (l.rotation ?? 0) * Math.PI / 180;
    const add = (x, y) => points.push([scale * (x * Math.cos(rotation) - y * Math.sin(rotation)), scale * (x * Math.sin(rotation) + y * Math.cos(rotation))]);
    const box = (w, h) => { for (const x of [-w / 2, w / 2]) for (const y of [-h / 2, h / 2]) add(x, y); };
    if (l.type === 'model') {
      const length = l.armLength ?? l.armLen ?? 0;
      const thick = l.armThickness ?? l.armThick ?? 0;
      const gap = l.armSpacing ?? l.gap ?? 0;
      const stroke = l.outline?.enabled ? (l.outline.width ?? 1) : 0;
      const count = Math.max(1, Math.round(l.armCount ?? 4));
      if (length > 0 && thick > 0) for (let i = 0; i < count; i++) {
        const a = -((l.armRotation ?? 0) + i * 360 / count) * Math.PI / 180;
        // Conservative polygon selection includes the SVG default miter limit (4).
        const pad = stroke / 2 * (l.armShape && l.armShape !== 'rect' ? 4 : 1);
        for (const x of [gap - pad, gap + length + pad]) for (const y of [-thick / 2 - pad, thick / 2 + pad]) add(x * Math.cos(a) - y * Math.sin(a), x * Math.sin(a) + y * Math.cos(a));
      }
      if (l.dot?.enabled && l.dot.size > 0) {
        const r = l.dot.size / 2 + (l.dot.shape === 'ring' ? .5 : stroke);
        if (!l.dot.shape || ['circle', 'ring'].includes(l.dot.shape)) points.push([-r * scale, -r * scale], [r * scale, r * scale]);
        else box(r * 2, r * 2);
      }
    }
    if (!points.length) return { w: 0, h: 0 };
    const xs = points.map(p => p[0]), ys = points.map(p => p[1]);
    const minX = Math.min(...xs), maxX = Math.max(...xs), minY = Math.min(...ys), maxY = Math.max(...ys);
    // Consumer centers selection at x/y and has no cx/cy support. Enclose
    // asymmetric arm counts about the origin, never shift their actual paint.
    return { w: Number(num(2 * Math.max(Math.abs(minX), Math.abs(maxX)))), h: Number(num(2 * Math.max(Math.abs(minY), Math.abs(maxY)))) };
  }

  const layerRenderers = {
    model(l) {
      const count = Math.max(1, Math.round(l.armCount ?? 4));
      const armLength = l.armLength ?? l.armLen ?? 8;
      const armThickness = l.armThickness ?? l.armThick ?? 2;
      const armSpacing = l.armSpacing ?? l.gap ?? 4;
      const armRotation = l.armRotation ?? 0;
      const layerRotation = l.rotation ?? 0;
      const scale = l.scale ?? 1;
      const x = l.x ?? 0;
      const y = l.y ?? 0;
      const armColor = escapeXml(color(l.armColor));
      const armShape = l.armShape || 'rect';

      const outline = l.outline || {};
      const outlineEnabled = !!outline.enabled;
      const outlineWidth = outline.width ?? 1;
      const outlineColor = escapeXml(color(outline.color, '#000000'));

      const dot = l.dot || {};
      const dotEnabled = !!dot.enabled && (dot.size ?? 0) > 0;
      const dotShape = dot.shape || 'circle';
      const dotColor = escapeXml(color(dot.color));
      const dotSize = dot.size ?? 4;

      const mid = armSpacing + armLength / 2;
      const armsDef = [];
      for (let i = 0; armLength > 0 && armThickness > 0 && i < count; i++) {
        const theta = armRotation + (i * 360) / count;
        const angle = (theta * Math.PI) / 180;
        const cx = Math.cos(angle) * mid;
        const cy = -Math.sin(angle) * mid;
        const shape = (armRenderers[armShape] || armRenderers.rect)({ w: armLength, h: armThickness });
        // Centers use model +Y up; SVG local +X must follow the same radial.
        armsDef.push(`<g transform="translate(${num(cx)} ${num(cy)}) rotate(${num(-theta)})">${shape}</g>`);
      }
      // Geometry is inlined, not <defs>/<use>: catalog documents hold many
      // inline SVGs and href="#id" resolves document-globally, so a shared
      // `#arms-<id>` made one card render another card's arms.
      const armsBody = armsDef.join('');
      // Legacy blur fields remain serializable data, never paint instructions.

      const layerTransform = `translate(${num(x)} ${num(-y)}) rotate(${num(layerRotation)}) scale(${num(scale)})`;

      const armsPart = `<g fill="${armColor}"${outlineEnabled ? ` stroke="${outlineColor}" stroke-width="${num(outlineWidth)}"` : ''}>${armsBody}</g>`;

      let dotPart = '';
      if (dotEnabled) {
        const r = dotSize / 2;
        const ring = dotShape === 'ring';
        const dotFill = ring ? 'none' : dotColor;
        const dotStroke = ring ? ` stroke="${dotColor}" stroke-width="1"` : '';
        const dotShapeEl = (dotRenderers[dotShape] || dotRenderers.circle)(r);
        // Original draws the dot outline as a filled shape behind the dot with
        // size = dot + outlineWidth (probed live: dot r=2, dotOutline r=3, fill #000).
        let dotOutlinePart = '';
        if (outlineEnabled && !ring) {
          const oEl = (dotRenderers[dotShape] || dotRenderers.circle)(r + outlineWidth);
          dotOutlinePart = `<g fill="${outlineColor}">${oEl}</g>`;
        }
        dotPart = `${dotOutlinePart}<g fill="${dotFill}"${dotStroke}>${dotShapeEl}</g>`;
      }

      return `<g transform="${layerTransform}">${armsPart}${dotPart}</g>`;
    },
    shape(l) {
      const x = l.x - l.w / 2, y = -l.y - l.h / 2;
      const attrs = `fill="${escapeXml(color(l.fill))}"${strokeAttr(l)}`;
      if (l.rotation) {
        return `<g transform="rotate(${-l.rotation} ${l.x} ${-l.y})">${layerRenderers._shapeAt(l, x, y, attrs)}</g>`;
      }
      return layerRenderers._shapeAt(l, x, y, attrs);
    },
    _shapeAt(l, x, y, attrs) {
      if (l.shape === 'ellipse') return `<ellipse cx="${l.x}" cy="${-l.y}" rx="${l.w / 2}" ry="${l.h / 2}" ${attrs}/>`;
      if (l.shape === 'triangle') return `<polygon points="${l.x},${y} ${x + l.w},${y + l.h} ${x},${y + l.h}" ${attrs}/>`;
      return `<rect x="${x}" y="${y}" width="${l.w}" height="${l.h}" ${attrs}/>`;
    },
    text(l) {
      const style = `font-family:${l.fontFamily};font-size:${l.fontSize}px` +
        (l.bold ? ';font-weight:bold' : '') + (l.italic ? ';font-style:italic' : '');
      const body = `<text x="${l.x}" y="${-l.y}" fill="${escapeXml(color(l.color))}" style="${escapeXml(style)}" text-anchor="middle" dominant-baseline="central">${escapeXml(l.text)}</text>`;
      if (!l.rotation) return body;
      return `<g transform="rotate(${-l.rotation} ${l.x} ${-l.y})">${body}</g>`;
    },
    image(l) {
      const body = `<image href="${escapeXml(raster(l.src))}" x="${l.x - l.w / 2}" y="${-l.y - l.h / 2}" width="${l.w}" height="${l.h}" preserveAspectRatio="none"/>`;
      if (!l.rotation) return body;
      return `<g transform="rotate(${-l.rotation} ${l.x} ${-l.y})">${body}</g>`;
    },
    draw(l) {
      if (!l.src) return '';
      const w = Math.round((l.w ?? 0) * (l.size ?? 1));
      const h = Math.round((l.h ?? 0) * (l.size ?? 1));
      if (w <= 0 || h <= 0) return '';
      const body = `<image id="draw-${l.id}" href="${escapeXml(raster(l.src))}" x="${l.x - w / 2}" y="${-l.y - h / 2}" width="${w}" height="${h}" preserveAspectRatio="none" style="image-rendering: pixelated; image-rendering: crisp-edges"/>`;
      if (!l.rotation) return body;
      return `<g transform="rotate(${-l.rotation} ${l.x} ${-l.y})">${body}</g>`;
    },
  };

  function escapeXml(s) {
    const A = String.fromCharCode(38);
    const map = { '<': A + 'lt;', '>': A + 'gt;', '&': A + 'amp;', '"': A + 'quot;', "'": A + 'apos;' };
    return String(s).replace(/[<>&"']/g, (c) => map[c]);
  }

  // Import contract: own layers only, never caller-supplied SVG. Draw is the
  // designer's raster canvas; vector paths/SVG images are not this schema.
  const MAX_IMAGE = 8 * 1024 * 1024;
  function object(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('objeto inválido');
    return value;
  }
  function color(value, fallback = '#ffffff') {
    if (value === undefined) return fallback;
    if (typeof value !== 'string' || value.length > 100 || !/^(?:#[\da-f]{3,4}|#[\da-f]{6}|#[\da-f]{8}|[a-z]+|(?:rgb|rgba|hsl|hsla)\([\d.,%+\-\s]+\))$/i.test(value)) throw new TypeError('cor inválida');
    return value;
  }
  function number(value, fallback, min = -100000, max = 100000) {
    if (value === undefined) return fallback;
    if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) throw new TypeError('número fora do limite');
    return value;
  }
  function boolean(value, fallback) {
    if (value === undefined) return fallback;
    if (typeof value !== 'boolean') throw new TypeError('booleano inválido');
    return value;
  }
  function choice(value, choices, fallback) {
    if (value === undefined) return fallback;
    if (!choices.includes(value)) throw new TypeError('opção inválida');
    return value;
  }
  function text(value, fallback, max) {
    if (value === undefined) return fallback;
    if (typeof value !== 'string' || value.length > max) throw new TypeError('texto fora do limite');
    return value;
  }
  function outline(value, stroke = false) {
    const v = object(value ?? {});
    return { enabled: boolean(v.enabled, false), color: color(v.color, '#000000'), width: number(v.width, 1, 0, 1000), ...(stroke ? {} : { blur: number(v.blur, 0, 0, 100) }) };
  }
  function validateModel(value) {
    const m = object(value);
    const d = object(m.dot ?? {});
    return { gap: number(m.gap, 4, 0), armLen: number(m.armLen, 8, 0), armThick: number(m.armThick, 2, 0), rotation: number(m.rotation, 0), opacity: number(m.opacity, 1, 0, 1), color: color(m.color),
      dot: { enabled: boolean(d.enabled, true), size: number(d.size, 2, 0), shape: choice(d.shape, ['circle', 'square'], 'circle') }, outline: outline(m.outline) };
  }
  function raster(src) {
    if (typeof src !== 'string' || src.length > MAX_IMAGE || !/^data:image\/(?:png|jpeg|gif|webp);base64,/.test(src)) throw new TypeError('imagem exige data:image raster base64 de até 8 MiB');
    const data = src.slice(src.indexOf(',') + 1);
    if (!data.length || data.length % 4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(data)) throw new TypeError('base64 inválido');
    return src;
  }
  // Overrides cumulativos por estágio: { property, to } com allowlist e limites.
  const FX_LIMITS = { scale: [0.05, 8], opacity: [0, 1], x: [-200, 200], y: [-200, 200], rotation: [-360, 360] };
  function stageEffects(value) {
    if (value === undefined) return [];
    if (!Array.isArray(value) || value.length > 8) throw new TypeError('efeitos inválidos (máximo 8 por estágio)');
    return value.map((entry) => {
      const e = object(entry);
      if (!Object.hasOwn(FX_LIMITS, e.property)) throw new TypeError('propriedade de efeito inválida');
      const [min, max] = FX_LIMITS[e.property];
      return { property: e.property, to: number(e.to, min, min, max) };
    });
  }
  function firingOptions(value) {
    const f = object(value);
    const easing = ['linear', 'ease', 'ease-in', 'ease-out', 'ease-in-out'];
    if (f.stages !== undefined && (!Array.isArray(f.stages) || f.stages.length > 128)) throw new TypeError('estágios inválidos');
    const pressType = choice(f.pressType, ['press', 'hold'], 'press');
    // One-shot press keeps release implicit (overlay ignores release); only hold defaults to reset.
    return { trigger: choice(f.trigger, ['none', 'left', 'right', 'autoplay'], 'none'), pressType, releaseBehavior: choice(f.releaseBehavior, ['reset', 'pause', 'reverse'], pressType === 'hold' ? 'reset' : undefined), direction: choice(f.direction, ['normal', 'reverse'], 'normal'), easing: choice(f.easing, easing, 'ease-out'), loop: boolean(f.loop, false), startDelay: number(f.startDelay, 0, 0, 60000), duration: number(f.duration, 300, 0, 60000), stages: (f.stages || []).map(stage => {
      const s = object(stage);
      return { delay: number(s.delay, 0, 0, 60000), duration: number(s.duration, 300, 0, 60000), easing: choice(s.easing, easing, 'ease-out'), effects: stageEffects(s.effects) };
    }) };
  }
  function validateLayers(value) {
    if (value === null || value === undefined) throw new TypeError('camadas inválidas');
    if (!Array.isArray(value) || value.length > 128) throw new TypeError('camadas inválidas (máximo 128)');
    let imageBytes = 0;
    const seenIds = new Set();
    return value.map((entry, index) => {
      const l = object(entry);
      const type = choice(l.type, ['model', 'shape', 'text', 'image', 'draw']);
      if (!type) throw new TypeError('tipo de camada ausente');
      const id = text(l.id, 'layer_' + index, 128);
      if (!/^[A-Za-z0-9_-]+$/.test(id)) throw new TypeError('id de camada inválido');
      if (seenIds.has(id)) throw new TypeError('id de camada duplicado');
      seenIds.add(id);
      const base = { id, type, name: text(l.name, '', 200), visible: boolean(l.visible, true), x: number(l.x, 0), y: number(l.y, 0), rotation: number(l.rotation, 0), scale: number(l.scale, 1, 0, 100), opacity: number(l.opacity, 1, 0, 1), ...(l.firingOptions === undefined ? {} : { firingOptions: firingOptions(l.firingOptions) }) };
      if (type === 'model') {
        const dot = object(l.dot ?? {});
        return { ...base, scale: number(l.scale, 1, 0, 100), armCount: number(l.armCount, 4, 1, 128), armSpacing: number(l.armSpacing ?? l.gap, 4, 0), armLength: number(l.armLength ?? l.armLen, 8, 0), armThickness: number(l.armThickness ?? l.armThick, 2, 0), armRotation: number(l.armRotation, 0), armShape: choice(l.armShape, ['rect', 'triangle', 'chevron'], 'rect'), armColor: color(l.armColor), armBlur: number(l.armBlur, 0, 0, 100), outline: outline(l.outline), dot: { enabled: boolean(dot.enabled, false), shape: choice(dot.shape, ['circle', 'square', 'diamond', 'ring'], 'circle'), color: color(dot.color), size: number(dot.size, 4, 0), blur: number(dot.blur, 0, 0, 100) } };
      }
      if (type === 'text') {
        const fontFamily = text(l.fontFamily, 'sans-serif', 200);
        if (!/^[\w\s,'"-]+$/.test(fontFamily)) throw new TypeError('fonte inválida');
        return { ...base, text: text(l.text, '', 4096), fontFamily, fontSize: number(l.fontSize, 16, 0, 1000), bold: boolean(l.bold, false), italic: boolean(l.italic, false), color: color(l.color) };
      }
      const box = { ...base, w: number(l.w, 20, 0), h: number(l.h, 20, 0) };
      if (type === 'shape') return { ...box, shape: choice(l.shape, ['rect', 'ellipse', 'triangle'], 'rect'), fill: color(l.fill), stroke: outline(l.stroke, true) };
      if (Object.hasOwn(l, 'paths')) throw new TypeError('draw.paths não suportado; exporte o desenho raster do designer');
      const src = raster(l.src);
      imageBytes += src.length;
      if (imageBytes > MAX_IMAGE * 2) throw new TypeError('imagens excedem 16 MiB');
      return { ...box, src, ...(type === 'draw' ? { size: number(l.size, 1, 0, 100) } : {}) };
    });
  }
  function validateCrosshair(value) {
    const payload = object(value);
    if (!Object.hasOwn(payload, 'model') && !Object.hasOwn(payload, 'layers') && !['gap', 'armLen', 'armThick', 'color', 'dot', 'outline'].some(key => Object.hasOwn(payload, key))) throw new TypeError('modelo ou camadas ausentes');
    const model = validateModel(payload.model === undefined ? (Array.isArray(payload.layers) ? {} : payload) : payload.model);
    const layers = validateLayers(payload.layers === undefined ? [] : payload.layers);
    if (payload.drawing != null && !Array.isArray(payload.layers)) throw new TypeError('drawing exige camadas; SVG isolado não é aceito');
    return { model, layers, drawing: layers.length || payload.drawing != null ? renderLayers(layers) : null };
  }

  // One editable representation for simple presets; never seed it from the
  // creator's dot-only defaults (those are new-document defaults, not imports).
  function modelToLayer(value, id = 'model') {
    const m = validateModel(value);
    return validateLayers([{
      id, type: 'model', rotation: m.rotation, opacity: m.opacity,
      armSpacing: m.gap, armLength: m.armLen, armThickness: m.armThick,
      armColor: m.color, dot: { ...m.dot, color: m.color }, outline: m.outline,
    }])[0];
  }

  function crosshairLayers(value) {
    const p = object(value);
    if (p.layers !== undefined) {
      const layers = validateLayers(p.layers);
      if (layers.length || p.drawing != null) return layers;
    }
    if (p.model !== undefined) return [modelToLayer(p.model)];
    if (['gap', 'armLen', 'armThick', 'color', 'dot', 'outline'].some(k => Object.hasOwn(p, k))) return [modelToLayer(p)];
    return [];
  }

  function renderCrosshair(value) {
    return renderLayers(crosshairLayers(value));
  }

  // bbox is measured paint bounds (including stroke/filter overflow). Caller
  // owns measurement; text metrics/images are browser data, not guessed here.
  function thumbnailSvg(value, bbox) {
    const body = renderCrosshair(value);
    if (!body) return '';
    const x = number(bbox?.x, 0), y = number(bbox?.y, 0);
    const w = number(bbox?.width, 0, 0, 1000000), h = number(bbox?.height, 0, 0, 1000000);
    const side = Math.max(w, h, 6);
    const padding = Math.max(1, side / 8);
    const size = side + padding * 2;
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${num(x + w / 2 - size / 2)} ${num(y + h / 2 - size / 2)} ${num(size)} ${num(size)}" width="100%" height="100%" preserveAspectRatio="xMidYMid meet" aria-hidden="true">${body}</svg>`;
  }

  function renderLayers(layers) {
    return validateLayers(layers || [])
      .filter((l) => l.visible !== false)
      .map((l) => {
        const renderer = layerRenderers[l.type];
        if (!renderer) return '';
        let body = renderer(l);
        // Geometry already has x/y: scale about the layer center, not document origin.
        // Model owns scale internally; draw.size changes intrinsic dimensions only once.
        if (l.type !== 'model' && l.scale !== 1) body = `<g transform="translate(${num(l.x)} ${num(-l.y)}) scale(${num(l.scale)}) translate(${num(-l.x)} ${num(l.y)})">${body}</g>`;
        return `<g id="layer-${l.id}" opacity="${l.opacity ?? 1}">${body}</g>`;
      })
      .join('');
  }

  return {
    uid, newModelLayer, newShapeLayer, newTextLayer, newImageLayer, newDrawLayer,
    renderLayers, layerRenderers, armRenderers, dotRenderers, escapeXml, layerBounds,
    validateModel, validateLayers, validateCrosshair, color,
    modelToLayer, crosshairLayers, renderCrosshair, thumbnailSvg,
  };
});
