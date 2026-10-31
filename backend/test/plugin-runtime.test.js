const assert = require('node:assert/strict');
const test = require('node:test');

const { resolveTemplate } = require('../plugin-runtime/template');
const { classifyStatus, extractProgress, normalizeResult, pickFirstString } = require('../plugin-runtime/extract');
const { validatePluginPackage } = require('../plugin-runtime/validate');
const { validateAndNormalizeInput, resolveModelFromFacets, isOptionAvailable, InputError } = require('../plugin-runtime/input');
const { buildContext, assertUrlAllowed, isLocallyScopedHost } = require('../plugin-runtime/executor');
const { verifyPlugin } = require('../plugin-runtime/verify');
const registry = require('../plugin-runtime/registry');

const PLUGIN_ID = 'qx-seedance';

function seedancePlugin() {
  const plugin = registry.getPlugin(PLUGIN_ID);
  assert.ok(plugin, `插件 ${PLUGIN_ID} 应能加载成功。加载失败原因: ${JSON.stringify(registry.listFailures())}`);
  return plugin;
}

// ===== 模板求值 =====

test('整串单表达式保留原始类型', () => {
  const ctx = { fields: { seconds: 8, list: ['a', 'b'] } };
  assert.equal(resolveTemplate('{{fields.seconds}}', ctx), 8);
  assert.deepEqual(resolveTemplate('{{fields.list}}', ctx), ['a', 'b']);
  assert.equal(resolveTemplate('{{string fields.seconds}}', ctx), '8');
});

test('插值到字符串中间时空值渲染为空串', () => {
  const ctx = { baseUrl: 'https://x.test', upstreamTaskId: 'abc' };
  assert.equal(resolveTemplate('{{baseUrl}}/v1/videos/{{upstreamTaskId}}', ctx), 'https://x.test/v1/videos/abc');
  assert.equal(resolveTemplate('{{baseUrl}}/v1/videos/{{missing}}', ctx), 'https://x.test/v1/videos/');
});

test('对象字段的空值被丢弃，$keep 可保留', () => {
  const resolved = resolveTemplate(
    { a: '{{missing}}', b: '{{list}}', c: '{{zero}}', d: { $keep: '{{missing}}' } },
    { list: [], zero: 0 },
  );
  assert.deepEqual(resolved, { c: 0, d: null });
});

test('$switch 命中 / 未命中 / 默认值', () => {
  const spec = { $switch: '{{facet.resolution}}', $cases: { '2K': '2K', '4K': '4K' } };
  assert.equal(resolveTemplate(spec, { facet: { resolution: '2K' } }), '2K');
  assert.equal(resolveTemplate(spec, { facet: { resolution: '768P' } }), undefined);
  assert.equal(
    resolveTemplate({ ...spec, $default: 'auto' }, { facet: { resolution: '768P' } }),
    'auto',
  );
});

test('concat 展平数组并丢空项，join 拼接', () => {
  const ctx = { media: { firstFrame: ['a'], lastFrame: [], multiImage: ['b', 'c'] } };
  assert.deepEqual(resolveTemplate('{{concat media.firstFrame media.lastFrame}}', ctx), ['a']);
  assert.deepEqual(resolveTemplate('{{concat media.firstFrame media.multiImage}}', ctx), ['a', 'b', 'c']);
  assert.equal(resolveTemplate("{{join ',' media.multiImage}}", ctx), 'b,c');
});

test('未知函数报错而不是静默当成路径', () => {
  assert.throws(() => resolveTemplate('{{nope a b}}', {}), /未知的模板函数/);
});

// ===== 上游响应取值 =====

test('状态词表归一化，未识别时按 processing 处理', () => {
  const spec = {
    completed: ['completed', 'success'],
    failed: ['failed'],
    queued: ['queued'],
    processing: ['processing'],
  };
  assert.equal(classifyStatus({ status: 'Success' }, spec, 't').state, 'completed');
  assert.equal(classifyStatus({ state: 'queued' }, spec, 't').state, 'queued');
  const unknown = classifyStatus({ status: 'wat' }, spec, 't');
  assert.equal(unknown.state, 'processing');
  assert.equal(unknown.recognized, false);
});

test('进度不做量纲猜测', () => {
  assert.equal(extractProgress({ progress: 42 }, { from: ['progress'] }), 42);
  assert.equal(extractProgress({ progress: '42' }, { from: ['progress'] }), 42);
  assert.equal(extractProgress({ progress: 0.5 }, { from: ['progress'], scale: '0-1' }), 50);
  assert.equal(extractProgress({}, { from: ['progress'] }), undefined);
  assert.equal(extractProgress({ progress: 'n/a' }, { from: ['progress'] }), undefined);
});

test('候选路径按顺序取第一个非空值', () => {
  assert.equal(pickFirstString({ b: 'second' }, ['a', 'b']), 'second');
  assert.equal(pickFirstString({ data: [{ url: 'deep' }] }, ['x', 'data.0.url']), 'deep');
  assert.equal(pickFirstString({ a: {} }, ['a']), undefined);
});

test('产物归一化：URL 改写与 fallback', () => {
  const spec = {
    assets: [{
      kind: 'video',
      url: ['video_url'],
      fallbackUrl: 'https://cdn.test/v1/videos/{{upstreamTaskId}}/content',
    }],
    rewriteHosts: { 'origin.internal.test': 'cdn.test' },
  };
  const ctx = { upstreamTaskId: 'task-1' };

  const rewritten = normalizeResult(
    { video_url: 'https://origin.internal.test/a.mp4' }, spec, ctx, resolveTemplate);
  assert.equal(rewritten.assets[0].url, 'https://cdn.test/a.mp4');

  const untouched = normalizeResult(
    { video_url: 'https://other.test/a.mp4' }, spec, ctx, resolveTemplate);
  assert.equal(untouched.assets[0].url, 'https://other.test/a.mp4');

  const fallback = normalizeResult({}, spec, ctx, resolveTemplate);
  assert.equal(fallback.assets[0].url, 'https://cdn.test/v1/videos/task-1/content');
});

// ===== Seedance 插件与输入契约 =====

function baseInput(overrides = {}) {
  return { facets: { targetModel: 'seedance-2.5', mode: 't2v' },
    fields: { prompt: '一只猫' }, media: {}, ...overrides };
}

function buildSubmit(input) {
  const plugin = seedancePlugin();
  return plugin.driver.buildSubmit(buildContext({ plugin, baseUrl: 'https://www.qlqqx.com', apiKey: 'fixture-key',
    ...validateAndNormalizeInput(plugin, input) }));
}

test('Seedance 插件加载、客户端描述与 12 种模型模式组合', () => {
  const p = seedancePlugin();
  assert.equal(p.manifest.models.length, 2);
  assert.equal(p.uiSchema.modelSelector.variants.length, 12);
  const description = registry.describeForClient(p);
  assert.equal(description.provider, undefined);
  assert.equal(description.driver, undefined);
  assert.equal(description.models[0].price.unit, 'per-second');
  assert.equal(resolveModelFromFacets(p.uiSchema, { targetModel: 'seedance-2.0', mode: 'edit' }), 'seedance-2.0');
  assert.equal(resolveModelFromFacets(p.uiSchema, { targetModel: 'seedance-2.0', mode: 'bad' }), null);
});

test('包校验器指出 manifest、模型引用及 allowRemoteUrl 的错误', () => {
  const p = seedancePlugin();
  const manifest = { ...p.manifest, id: 'Bad_Id', version: 'bad', kind: 'audio' };
  const schema = structuredClone(p.uiSchema);
  schema.modelSelector.variants[0].model = 'missing';
  schema.fields[0].allowRemoteUrl = 'yes';
  const result = validatePluginPackage({ manifest, uiSchema: schema, driver: p.driver, hasScriptDriver: true, dirName: PLUGIN_ID });
  assert.equal(result.ok, false);
  for (const term of [/manifest.id/, /manifest.version/, /manifest.kind/, /未在 manifest.models/, /allowRemoteUrl/]) {
    assert.match(result.message, term);
  }
});

test('默认字段、隐藏素材与 edit 时长', () => {
  assert.deepEqual(buildSubmit(baseInput()).body, { model: 'seedance-2.5', content: [{ type: 'text', text: '一只猫' }],
    resolution: '720p', ratio: 'adaptive', duration: 5, generate_audio: true, watermark: false });
  const body = buildSubmit(baseInput({ facets: { targetModel: 'seedance-2.5', mode: 'edit' }, fields: { prompt: '修改', duration: -1 },
    media: { sourceVideo: ['https://media.test/in.mp4'], firstFrame: ['https://media.test/hidden.png'] } })).body;
  assert.equal(body.duration, undefined);
  assert.equal(body.omni_reference_task_type, 'edit');
  assert.equal(body.content.length, 2);
});

test('素材支持混合 HTTPS 与上传地址，外链不进入本机素材绑定清单', () => {
  const p = seedancePlugin();
  const media = { referenceImages: ['/api/nova/plugin-media/a.png', 'https://media.test/b.png'] };
  const n = validateAndNormalizeInput(p, baseInput({ facets: { targetModel: 'seedance-2.5', mode: 'reference' }, media }));
  assert.deepEqual(n.media, media);
  assert.deepEqual(n.mediaUrls, ['/api/nova/plugin-media/a.png']);
  for (const url of ['http://media.test/a.png', 'file:///tmp/a', 'data:image/png;base64,a', 'https://u:p@media.test/a.png']) {
    assert.throws(() => validateAndNormalizeInput(p, baseInput({ facets: { targetModel: 'seedance-2.5', mode: 'reference' },
      media: { referenceImages: [url] } })), InputError);
  }
  const localOnly = { ...p, uiSchema: structuredClone(p.uiSchema) };
  localOnly.uiSchema.fields.find(f => f.key === 'referenceImages').allowRemoteUrl = false;
  assert.throws(() => validateAndNormalizeInput(localOnly, baseInput({ facets: { targetModel: 'seedance-2.5', mode: 'reference' },
    media: { referenceImages: ['https://media.test/b.png'] } })), /无效的素材地址/);
});

test('首尾帧必填、reference 非空与 2.0 音频单独输入限制', () => {
  const p = seedancePlugin();
  assert.throws(() => validateAndNormalizeInput(p, baseInput({ facets: { targetModel: 'seedance-2.5', mode: 'firstlast' } })), /首帧.*必填/);
  assert.throws(() => validateAndNormalizeInput(p, baseInput({ facets: { targetModel: 'seedance-2.5', mode: 'firstlast' },
    media: { firstFrame: ['https://media.test/first.png'] } })), /尾帧.*必填/);
  assert.throws(() => validateAndNormalizeInput(p, baseInput({ facets: { targetModel: 'seedance-2.5', mode: 'reference' } })), /至少需要/);
  assert.throws(() => validateAndNormalizeInput(p, baseInput({ facets: { targetModel: 'seedance-2.0', mode: 'reference' },
    media: { referenceAudios: ['https://media.test/a.mp3'] } })), /不能仅使用参考音频/);
});

test('模型时长、首帧画幅、素材个数及提示词权威校验', () => {
  const p = seedancePlugin();
  for (const duration of [16, 30]) {
    assert.throws(() => validateAndNormalizeInput(p, baseInput({ facets: { targetModel: 'seedance-2.0', mode: 't2v' },
      fields: { prompt: 'p', duration } })), /不支持/);
  }
  for (const duration of [-1, 4, 30]) assert.equal(buildSubmit(baseInput({ fields: { prompt: 'p', duration } })).body.duration, duration);
  assert.throws(() => validateAndNormalizeInput(p, baseInput({ facets: { targetModel: 'seedance-2.5', mode: 'i2v' },
    fields: { prompt: 'p', ratio: '16:9' }, media: { firstFrame: ['https://media.test/i.png'] } })), /当前组合下不支持「画面比例」/);
  assert.throws(() => validateAndNormalizeInput(p, baseInput({ facets: { targetModel: 'seedance-2.0', mode: 'reference' },
    media: { referenceVideos: Array(4).fill('https://media.test/v.mp4') } })), /最多 3 个/);
  for (const fields of [{ prompt: '' }, { prompt: 'x'.repeat(10001) }, { prompt: 'p', duration: 31 }]) {
    assert.throws(() => validateAndNormalizeInput(p, baseInput({ fields })), InputError);
  }
  assert.throws(() => validateAndNormalizeInput(p, baseInput({ model: 'seedance-2.0' })), /不匹配/);
});

test('Seedance 状态映射和错误文案', () => {
  const { normalizePollResponse, resolvePollTiming } = require('../plugin-runtime/executor');
  const p = seedancePlugin();
  for (const status of ['queued', 'running']) assert.equal(normalizePollResponse(p, { status }, {}).state, 'processing');
  for (const status of ['failed', 'cancelled', 'expired']) {
    assert.deepEqual(normalizePollResponse(p, { status, error: { message: '错误原因' } }, {}), { state: 'failed', error: '错误原因' });
  }
  assert.equal(normalizePollResponse(p, { status: 'succeeded', content: {} }, {}).state, 'failed');
  assert.deepEqual(resolvePollTiming(p), { intervalMs: 10000, maxTotalMs: 43200000 });
});

test('出网闸门拒绝未申报地址，嵌入时仅放行固定网关 origin', () => {
  const p = seedancePlugin();
  assert.throws(() => assertUrlAllowed(p, 'https://evil.test/a', '创建'), /未在 manifest/);
  assert.throws(() => assertUrlAllowed(p, 'http://127.0.0.1/a', '创建'), /内网/);
  assert.throws(() => assertUrlAllowed(p, 'file:///tmp/a', '创建'), /http\/https/);
  const embed = { enabled: true, gatewayUrl: 'http://127.0.0.1:8080' };
  assert.equal(assertUrlAllowed(p, `${embed.gatewayUrl}/api/v3/contents/generations/tasks`, '创建', embed), `${embed.gatewayUrl}/api/v3/contents/generations/tasks`);
  assert.throws(() => assertUrlAllowed(p, 'https://www.qlqqx.com/api/v3/contents/generations/tasks', '创建', embed), /固定网关/);
  for (const host of ['localhost', '127.0.0.1', '10.0.0.1', '192.168.1.1', '172.16.0.1', '169.254.169.254', '::1']) {
    assert.equal(isLocallyScopedHost(host), true);
  }
});

test('全部插件 fixtures 校验通过，覆盖六种模式及变更 01 规格快照', () => {
  assert.deepEqual(registry.listFailures(), []);
  const results = verifyPlugin(seedancePlugin());
  assert.equal(results.length, 9);
  for (const result of results) assert.ok(result.ok, `${result.name}: ${result.error}`);
});

test('选项 availableWhen 与 unavailableWhen 同时生效，禁用条件按键 AND 匹配', () => {
  const option = { availableWhen: { tier: ['standard'] }, unavailableWhen: { model: ['new'], mode: ['i2v', 'firstlast'] } };
  assert.equal(isOptionAvailable({}, {}), true);
  assert.equal(isOptionAvailable(option, { tier: 'lite', model: 'old', mode: 't2v' }), false);
  assert.equal(isOptionAvailable(option, { tier: 'standard', model: 'new', mode: 'i2v' }), false);
  assert.equal(isOptionAvailable(option, { tier: 'standard', model: 'old', mode: 'i2v' }), true);
  assert.equal(isOptionAvailable(option, { tier: 'standard', model: 'new', mode: 't2v' }), true);
  assert.equal(isOptionAvailable({ unavailableWhen: { mode: ['i2v'] } }, { mode: 'i2v' }), false);
  assert.equal(isOptionAvailable({ unavailableWhen: {} }, {}), false);
});

test('schema 校验接受合法 unavailableWhen，并拒绝与 availableWhen 同类的格式错误', () => {
  const p = seedancePlugin();
  const validate = uiSchema => validatePluginPackage({ manifest: p.manifest, uiSchema,
    driver: p.driver, hasScriptDriver: true, dirName: PLUGIN_ID });
  assert.equal(validate(p.uiSchema).ok, true);
  for (const invalid of ['i2v', null, { mode: [] }, { mode: 'i2v' }]) {
    const schema = structuredClone(p.uiSchema);
    schema.fields.find(field => field.key === 'ratio').options[1].unavailableWhen = invalid;
    const result = validate(schema);
    assert.equal(result.ok, false);
    assert.match(result.message, /\.options\[1\]\.unavailableWhen/);
  }
});

test('Seedance 2.5 首帧/首尾帧禁用六个固定比例，2.0 首帧允许 16:9', () => {
  const p = seedancePlugin();
  const ratio = p.uiSchema.fields.find(field => field.key === 'ratio');
  assert.equal(ratio.options.find(option => option.value === 'adaptive').unavailableWhen, undefined);
  assert.equal(ratio.options.filter(option => option.unavailableWhen).length, 6);
  for (const mode of ['i2v', 'firstlast']) {
    const media = { firstFrame: ['https://media.test/first.png'],
      ...(mode === 'firstlast' ? { lastFrame: ['https://media.test/last.png'] } : {}) };
    const input = baseInput({ facets: { targetModel: 'seedance-2.5', mode }, fields: { prompt: 'p', ratio: '16:9' }, media });
    for (const option of ratio.options.filter(option => option.value !== 'adaptive')) {
      assert.deepEqual(option.unavailableWhen, { targetModel: ['seedance-2.5'], mode: ['i2v', 'firstlast'] });
      assert.throws(() => validateAndNormalizeInput(p, { ...input, fields: { ...input.fields, ratio: option.value } }), /不支持「画面比例」/);
    }
    assert.equal(buildSubmit({ ...input, fields: { prompt: 'p', ratio: 'adaptive' } }).body.ratio, 'adaptive');
    assert.equal(buildSubmit({ ...input, facets: { targetModel: 'seedance-2.0', mode } }).body.ratio, '16:9');
    assert.throws(() => p.driver.validateInput({ facets: input.facets, fields: input.fields, media }), /只能为 adaptive/);
  }
  assert.equal(buildSubmit(baseInput({ fields: { prompt: 'p', ratio: '16:9' } })).body.ratio, '16:9');
});

test('变更 01：4k 仅 2.0 可选，两个模型默认 720p / 5 秒 / adaptive 并支持自动时长', () => {
  const p = seedancePlugin();
  const fourK = p.uiSchema.fields.find(field => field.key === 'resolution').options.find(option => option.value === '4k');
  assert.equal(p.uiSchema.modelSelector.familyDescription, '按秒计费');
  assert.ok(fourK);
  assert.equal(isOptionAvailable(fourK, { targetModel: 'seedance-2.0' }), true);
  assert.equal(isOptionAvailable(fourK, { targetModel: 'seedance-2.5' }), false);
  for (const model of ['seedance-2.0', 'seedance-2.5']) {
    const input = baseInput({ facets: { targetModel: model, mode: 't2v' } });
    const defaults = buildSubmit(input).body;
    assert.equal(defaults.resolution, '720p');
    assert.equal(defaults.duration, 5);
    assert.equal(defaults.ratio, 'adaptive');
    assert.equal(buildSubmit({ ...input, fields: { prompt: 'p', duration: -1 } }).body.duration, -1);
    for (const resolution of ['480p', '720p', '1080p']) {
      assert.equal(buildSubmit({ ...input, fields: { prompt: 'p', resolution } }).body.resolution, resolution);
    }
    const with4k = { ...input, fields: { prompt: 'p', resolution: '4k' } };
    if (model === 'seedance-2.0') assert.equal(buildSubmit(with4k).body.resolution, '4k');
    else assert.throws(() => validateAndNormalizeInput(p, with4k), /不支持「分辨率」/);
  }
});

test('变更 01：2.0 参考图/音频上限为 9/3，2.5 为 30/10，超量仍拒绝', () => {
  const p = seedancePlugin();
  assert.equal(p.manifest.media.images.maxCount, 30);
  assert.equal(p.manifest.media.audios.maxCount, 10);
  for (const [model, imageLimit, audioLimit] of [['seedance-2.0', 9, 3], ['seedance-2.5', 30, 10]]) {
    const images = Array.from({ length: imageLimit }, (_, index) => `https://media.test/image-${index}.png`);
    const audios = Array.from({ length: audioLimit }, (_, index) => `https://media.test/audio-${index}.mp3`);
    const input = baseInput({ facets: { targetModel: model, mode: 'reference' }, media: { referenceImages: images, referenceAudios: audios } });
    const body = buildSubmit(input).body;
    assert.equal(body.content.filter(item => item.role === 'reference_image').length, imageLimit);
    assert.equal(body.content.filter(item => item.role === 'reference_audio').length, audioLimit);
    assert.throws(() => validateAndNormalizeInput(p, { ...input, media: { ...input.media, referenceImages: [...images, 'https://media.test/extra.png'] } }), new RegExp(`参考图片.*最多 ${imageLimit} 个`));
    assert.throws(() => validateAndNormalizeInput(p, { ...input, media: { ...input.media, referenceAudios: [...audios, 'https://media.test/extra.mp3'] } }), new RegExp(`参考音频.*最多 ${audioLimit} 个`));
  }
});
