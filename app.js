/* 股价高弹性筛选工作台 · 前端逻辑
   双模式：
     static —— 存在 data/snapshot.json，前端本地筛选（公网静态部署）
     api    —— 回退到本地 FastAPI 后端（实时筛选） */
'use strict';

const $  = (s) => document.querySelector(s);
const $$ = (s) => Array.from(document.querySelectorAll(s));

const state = {
  mode: null, snapshot: null, result: null, charts: {},
  custom: { codes: [], rows: [], missing: [], loaded: false },
};

/* ---------- 工具 ----------
   isNum / fmt 在 screener.js 中定义并暴露到 window。
   这里用 var + fallback，避免两个 <script> 共享全局作用域时重复 const 声明 */
var isNum = window.isNum || function(v) {
  return v !== null && v !== undefined && typeof v === 'number' && isFinite(v);
};
var fmt = window.fmt || function(v, d) {
  d = d === undefined ? 2 : d;
  return isNum(v) ? Number(v).toFixed(d) : '—';
};
const cls = (v) => (!isNum(v) ? 'flat' : (v > 0 ? 'up' : (v < 0 ? 'down' : 'flat')));

function toast(msg, type = '') {
  const t = $('#toast');
  t.textContent = msg;
  t.className = 'toast ' + type;
  t.classList.remove('hidden');
  clearTimeout(t._t);
  t._t = setTimeout(() => t.classList.add('hidden'), 3400);
}

/* ECharts 通用底座 */
const AXIS = {
  axisLine:  { lineStyle: { color: '#30363d' } },
  axisLabel: { color: '#8b949e', fontSize: 11 },
  splitLine: { lineStyle: { color: '#21262d' } },
};
const baseOpt = () => ({
  backgroundColor: 'transparent',
  textStyle: { color: '#8b949e', fontFamily: 'inherit' },
  tooltip: {
    backgroundColor: '#1c2128', borderColor: '#30363d',
    textStyle: { color: '#e6edf3', fontSize: 12 },
  },
});
function chart(id, opt) {
  const el = document.getElementById(id);
  if (!el) return null;
  let c = state.charts[id];
  if (!c) c = state.charts[id] = echarts.init(el);
  c.setOption(opt, true);
  return c;
}
window.addEventListener('resize', () => {
  Object.values(state.charts).forEach((c) => c && c.resize());
});

function setLoading(msg) {
  $('#dotStatus').className = 'dot';
  $('#txtStatus').textContent = '连接中…';
  $('#emptyState').innerHTML =
    `<div class="empty-icon">◈</div><p>${msg}</p><p class="muted">请稍候</p>`;
}

function setBootError(msg, detail) {
  $('#dotStatus').className = 'dot err';
  $('#txtStatus').textContent = '加载失败';
  $('#emptyState').innerHTML =
    `<div class="empty-icon">◈</div><p>${msg}</p>` +
    `<p class="muted">${detail || '请检查网络或稍后刷新'}</p>`;
  console.error('[BOOT]', msg, detail);
}

/* ---------- 启动：探测模式 ---------- */
async function boot() {
  setLoading('正在加载数据快照…');

  // 1) 尝试静态快照
  try {
    const r = await fetch('data/snapshot.json', { cache: 'no-store' });
    if (!r.ok) throw new Error('snapshot.json HTTP ' + r.status);
    const text = await r.text();
    let snap;
    try { snap = JSON.parse(text); } catch (e) {
      throw new Error('JSON 解析失败：' + (e.message || '') + '（前50字：' + text.slice(0, 50) + '…）');
    }
    if (!snap || !snap.rows || !snap.rows.length) {
      throw new Error('快照为空（rows=' + (snap && snap.rows ? snap.rows.length : 'missing') + '）');
    }
    state.mode = 'static';
    state.snapshot = snap;
    initStatic();
    return;
  } catch (e) {
    console.warn('静态快照加载失败：', e);
    // 如果明确是数据文件问题，直接报出来，不要默默回退
    const msg = String(e.message || e);
    if (msg.includes('snapshot.json') || msg.includes('JSON') || msg.includes('快照')) {
      setBootError('数据快照加载失败', msg);
      return;
    }
  }

  // 2) 回退后端 API
  try {
    const h = await fetch('/api/health');
    if (h.ok) {
      state.mode = 'api';
      await initApi();
      return;
    }
  } catch (e) { console.warn('后端回退失败：', e); }

  // 3) 都不可用
  setBootError('未找到数据快照，后端也未启动',
    '静态部署请确认 frontend/data/snapshot.json 存在；本地使用请运行 start.bat');
}

function initStatic() {
  try {
    const m = state.snapshot.meta || {};
    $('#dotStatus').className = 'dot ok';
    $('#txtStatus').textContent = '数据快照';
    $('#txtTime').textContent = m.generated_at || '';
    $('#emptyState').innerHTML =
      `<div class="empty-icon">◈</div><p>配置左侧参数后点击「开始筛选」</p>
       <p class="muted">高弹性 = 对市场敏感 + 波动幅度大 + 资金活跃 · 数据 ${m.generated_at || ''}</p>`;

  // 股票池：全部 + 各成分池 + 自选股
  const pools = ['全部', ...(m.pools || []), '自选股'];
  $('#selPool').innerHTML = pools
    .map((p) => `<option value="${p}"${p === m.pools?.[0] ? ' selected' : ''}>${p}</option>`)
    .join('');
  $('#lblPool').textContent = `股票池（快照共 ${m.total} 只）`;

  $('#selBench').innerHTML = `<option>${m.benchmark}</option>`;
  $('#selDiagBench').innerHTML = `<option>${m.benchmark}</option>`;
  $('#selStyle').innerHTML = Object.keys(WEIGHTS).map((k) => {
    const lb = { balanced: '均衡（默认）', swing: '短线波段', trend: '趋势跟随', leader: '题材龙头' }[k];
    const d = {
      balanced: 'β25 / 波动30 / 振幅10 / 换手25 / 带宽10',
      swing: '换手率权重提升至 35%', trend: 'β 权重提升至 35%',
      leader: 'β + 换手并重（各 30%）',
    }[k];
    return `<option value="${k}">${lb} — ${d}</option>`;
  }).join('');
  updateStyleHint();

  // 快照模式无需"精算深度"
  $('#grpDepth').classList.add('hidden');
  $('#btnExport').textContent = '导出 Excel';
  toast(`已加载 ${m.total} 只标的快照（${m.generated_at}）`, 'ok');
  } catch (e) {
    setBootError('初始化静态模式失败', e.message || String(e));
  }
}

async function initApi() {
  const h = await fetch('/api/health').then((x) => x.json());
  $('#dotStatus').className = 'dot ok';
  $('#txtStatus').textContent = '后端实时';
  $('#txtTime').textContent = h.time || '';

  const m = await fetch('/api/meta').then((x) => x.json());
  $('#selPool').innerHTML = [...m.pools, '自选股']
    .map((p) => `<option>${p}</option>`).join('');
  $('#selBench').innerHTML = m.benchmarks.map((b) => `<option>${b}</option>`).join('');
  $('#selDiagBench').innerHTML = m.benchmarks.map((b) => `<option>${b}</option>`).join('');
  $('#selStyle').innerHTML = m.styles
    .map((s) => `<option value="${s.key}">${s.label} — ${s.desc}</option>`).join('');
  updateStyleHint();
}

/* ============ 自选股 ============ */

/* 切换股票池时展开/收起导入面板 */
$('#selPool').addEventListener('change', () => {
  const isCustom = $('#selPool').value === '自选股';
  $('#grpCustom').classList.toggle('hidden', !isCustom);
});

/* 选择文件 */
$('#btnPickFile').addEventListener('click', () => $('#fileCustom').click());
$('#fileCustom').addEventListener('change', (e) => {
  const f = e.target.files && e.target.files[0];
  if (!f) return;
  const reader = new FileReader();
  reader.onload = (ev) => {
    $('#inpCustom').value = ev.target.result;
    const n = extractCodes(ev.target.result).length;
    $('#fileCustomName').textContent = `${f.name} — 识别到 ${n} 个代码`;
  };
  reader.readAsText(f, 'UTF-8');
});

/* 导入 */
$('#btnImport').addEventListener('click', importCustom);

function setCustomStatus(html) {
  const el = $('#hintCustom');
  el.innerHTML = html;
  el.classList.add('show');
}

async function importCustom() {
  const codes = extractCodes($('#inpCustom').value);
  if (!codes.length) {
    setCustomStatus('<span class="warn">未识别到有效代码</span><br>请检查格式，应为 6 位数字');
    toast('未识别到有效股票代码', 'err');
    return;
  }

  state.custom = { codes, rows: [], missing: [], loaded: false };
  setCustomStatus('正在匹配…');
  $('#btnImport').disabled = true;

  try {
    if (state.mode === 'static') {
      // 静态快照：只能匹配已覆盖的标的
      const { matched, missing } = matchCustom(codes, state.snapshot.rows);
      state.custom.rows = matched;
      state.custom.missing = missing;
      state.custom.loaded = true;

      let html = `<span class="ok">已匹配 ${matched.length} 只</span> / 共 ${codes.length} 只`;
      if (missing.length) {
        html += `<span class="miss">未覆盖 ${missing.length} 只（不在沪深300+中证500+中证1000 内）：` +
                `${missing.slice(0, 30).join('、')}${missing.length > 30 ? '…' : ''}</span>`;
        html += `<span class="miss">提示：这些标的需用「本地实时版」才能实时计算</span>`;
      }
      setCustomStatus(html);
      toast(matched.length ? `已导入 ${matched.length} 只自选股` : '快照中无匹配标的',
            matched.length ? 'ok' : 'err');
    } else {
      // 后端实时计算
      const res = await fetch('/api/custom', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          codes, bench: $('#selBench').value,
          hist_days: Number($('#selDepth').value) > 0 ? 300 : 300,
        }),
      });
      const d = await res.json();
      if (!res.ok) throw new Error(d.detail || '导入失败');
      state.custom.rows = d.rows || [];
      state.custom.missing = d.missing || [];
      state.custom.loaded = true;

      let html = `<span class="ok">已计算 ${(d.rows || []).length} 只</span> / 共 ${codes.length} 只`;
      if (state.custom.missing.length) {
        html += `<span class="miss">未取到行情 ${state.custom.missing.length} 只：` +
                `${state.custom.missing.slice(0, 30).join('、')}` +
                `${state.custom.missing.length > 30 ? '…' : ''}</span>`;
      }
      setCustomStatus(html);
      toast(`已导入 ${(d.rows || []).length} 只自选股`, 'ok');
    }
  } catch (e) {
    setCustomStatus(`<span class="warn">导入失败：${e.message}</span>`);
    toast('导入失败：' + e.message, 'err');
  } finally {
    $('#btnImport').disabled = false;
  }
}

$('#selStyle').addEventListener('change', updateStyleHint);
function updateStyleHint() {
  $('#hintStyle').textContent =
    ($('#selStyle').selectedOptions[0]?.textContent || '').split('—')[1] || '';
}

/* 滑块联动 */
[['volMin', 'lblVol', 1], ['ampMin', 'lblAmp', 1],
 ['turnMin', 'lblTurn', 1], ['vrMin', 'lblVr', 1]].forEach(([inp, lbl, d]) => {
  const el = $('#' + inp);
  el.addEventListener('input', () => { $('#' + lbl).textContent = Number(el.value).toFixed(d); });
});

/* ---------- 参数 ---------- */
function collectParams() {
  const n = (id) => Number($('#' + id).value);
  return {
    pool: $('#selPool').value,
    bench: $('#selBench').value,
    style: $('#selStyle').value,
    mv_min: n('mvMin'), mv_max: n('mvMax'),
    beta_min: n('betaMin'), beta_max: n('betaMax'),
    vol_min: n('volMin'), amp_min: n('ampMin'),
    turnover_min: n('turnMin'), volratio_min: n('vrMin'),
    top_n: n('topN'), max_candidates: n('selDepth'), hist_days: 300,
  };
}

$('#btnReset').addEventListener('click', () => {
  $('#betaMin').value = 1.2; $('#betaMax').value = 2.0;
  $('#volMin').value = 30;   $('#lblVol').textContent = '30';
  $('#ampMin').value = 2;    $('#lblAmp').textContent = '2.0';
  $('#turnMin').value = 0.8; $('#lblTurn').textContent = '0.8';
  $('#vrMin').value = 0;     $('#lblVr').textContent = '0.0';
  $('#mvMin').value = 0;     $('#mvMax').value = 100000;
  $('#topN').value = 30;
  toast('已恢复默认参数');
});

/* ---------- 筛选 ---------- */
$('#btnScreen').addEventListener('click', doScreen);

async function doScreen() {
  const params = collectParams();
  $('#resultArea').classList.add('hidden');
  $('#emptyState').classList.add('hidden');

  const isCustom = params.pool === '自选股';

  if (state.mode === 'static') {
    // 自选股：改用导入后的数据，且必须先导入
    if (isCustom) {
      if (!state.custom.loaded) {
        $('#emptyState').classList.remove('hidden');
        toast('请先在「自选股代码」框粘贴代码并点击「导入」', 'err');
        return;
      }
      if (!state.custom.rows.length) {
        return showEmpty({ message: '导入的自选股在快照中无匹配，请用本地实时版计算' });
      }
    }
    const src = isCustom ? state.custom.rows : state.snapshot.rows;
    const t0 = performance.now();
    const { rows, matched } = screenRows(src, params);
    const elapsed = (performance.now() - t0) / 1000;
    if (!rows.length) return showEmpty(params);
    state.result = {
      rows, params, elapsed: Number(elapsed.toFixed(2)), passed: matched,
      scanned: src.length, relaxed: false,
      summary: summarize(rows), weights: WEIGHTS[params.style],
      benchmark: state.snapshot.meta.benchmark,
      generated_at: state.snapshot.meta.generated_at,
      meta: state.snapshot.meta,
    };
    render(state.result);
    $('#loading').classList.add('hidden');
    $('#resultArea').classList.remove('hidden');
    toast(`筛选完成 · ${matched} 只命中 · ${elapsed.toFixed(2)}s`, 'ok');
    return;
  }

  // API 模式
  $('#loading').classList.remove('hidden');
  $('#btnScreen').disabled = true;

  // 自选股走专用接口（后端实时计算任意 A 股）
  if (isCustom) {
    if (!state.custom.codes.length) {
      $('#loading').classList.add('hidden');
      $('#emptyState').classList.remove('hidden');
      toast('请先导入自选股代码', 'err');
      $('#btnScreen').disabled = false;
      return;
    }
    $('#loadingText').textContent = `正在计算 ${state.custom.codes.length} 只自选股…`;
    try {
      const res = await fetch('/api/custom', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          codes: state.custom.codes,
          bench: params.bench,
          params,          // 由后端复用同一套过滤与打分逻辑
          hist_days: 300,
        }),
      });
      const d = await res.json();
      if (!res.ok) throw new Error(d.detail || '筛选失败');
      if (!d.rows || !d.rows.length) {
        $('#loading').classList.add('hidden');
        return showEmpty(d);
      }
      d.meta = { data_source: '新浪财经日线（实时计算）' };
      state.result = d;
      render(d);
      $('#loading').classList.add('hidden');
      $('#resultArea').classList.remove('hidden');
      toast(`筛选完成 · ${d.rows.length} 只命中 · 耗时 ${d.elapsed}s`, 'ok');
    } catch (e) {
      $('#loading').classList.add('hidden');
      showEmpty({ message: e.message });
    } finally {
      $('#btnScreen').disabled = false;
    }
    return;
  }

  $('#loadingText').textContent = `正在精算 ${params.pool} 成分股…`;
  try {
    const res = await fetch('/api/screen', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(params),
    });
    const d = await res.json();
    if (!res.ok) throw new Error(d.detail || '筛选失败');
    if (!d.rows || !d.rows.length) {
      $('#loading').classList.add('hidden');
      return showEmpty(d);
    }
    d.meta = { data_source: '新浪财经日线 + 中证指数成分' };
    state.result = d;
    render(d);
    $('#loading').classList.add('hidden');
    $('#resultArea').classList.remove('hidden');
    toast(`筛选完成 · ${d.passed} 只命中 · 耗时 ${d.elapsed}s`, 'ok');
    if (d.relaxed) toast('阈值过严已自动放宽，请适当调整条件', 'err');
  } catch (e) {
    $('#loading').classList.add('hidden');
    showEmpty({ message: e.message });
  } finally {
    $('#btnScreen').disabled = false;
  }
}

function showEmpty(d) {
  $('#emptyState').classList.remove('hidden');
  $('#emptyState').innerHTML =
    `<div class="empty-icon">◈</div><p>没有符合条件的标的</p>
     <p class="muted">${d.message || '建议放宽 β / 波动率 / 换手率阈值'}</p>`;
}

/* ---------- 渲染 ---------- */
function render(d) {
  renderSummary(d);
  renderScatter(d.rows);
  renderBar(d.rows);
  renderPie(d.rows);
  renderTable(d.rows);
  const m = d.meta || {};
  $('#tblInfo').textContent =
    `命中 ${d.passed} 只 · 扫描 ${d.scanned} 只 · β基准 ${d.benchmark || '-'} · ` +
    `数据时间 ${d.generated_at || '-'} · 计算耗时 ${d.elapsed}s`;
}

function renderSummary(d) {
  const s = d.summary || {};
  const cards = [
    ['命中标的', d.passed, '只'],
    ['平均 β', fmt(s.avg_beta, 2), ''],
    ['平均年化波动率', fmt(s.avg_vol, 1), '%'],
    ['平均换手率', fmt(s.avg_turnover, 2), '%'],
    ['平均振幅', fmt(s.avg_amp, 2), '%'],
    ['耗时', fmt(d.elapsed, 2), 's'],
  ];
  $('#summaryCards').innerHTML = cards.map(([lb, vl, un]) =>
    `<div class="scard"><div class="lb">${lb}</div>
     <div class="vl">${vl}<span class="un">${un}</span></div></div>`).join('');
}

function renderScatter(rows) {
  const pts = rows.filter((r) => isNum(r.beta) && isNum(r.ann_vol)).map((r) => ({
    value: [r.beta, r.ann_vol, r.turnover || 0, r.elastic_score || 0],
    name: r.name, code: r.code,
  }));
  if (!pts.length) return;
  chart('chartScatter', {
    ...baseOpt(),
    grid: { left: 52, right: 22, top: 22, bottom: 46 },
    tooltip: {
      ...baseOpt().tooltip,
      formatter: (p) => {
        const v = p.data.value;
        return `<b>${p.data.name}</b> (${p.data.code})<br/>β：${fmt(v[0])}<br/>` +
               `年化波动率：${fmt(v[1])}%<br/>换手率：${fmt(v[2])}%<br/>` +
               `综合得分：${fmt(v[3], 1)}`;
      },
    },
    xAxis: { ...AXIS, type: 'value', name: 'β 系数',
             nameTextStyle: { color: '#8b949e', fontSize: 11 },
             nameLocation: 'middle', nameGap: 27 },
    yAxis: { ...AXIS, type: 'value', name: '年化波动率 %',
             nameTextStyle: { color: '#8b949e', fontSize: 11 } },
    visualMap: {
      min: Math.min(...pts.map((p) => p.value[3])),
      max: Math.max(...pts.map((p) => p.value[3])),
      dimension: 3, orient: 'vertical', right: 4, top: 'center',
      text: ['高', '低'], textStyle: { color: '#8b949e', fontSize: 10 },
      itemWidth: 11, itemHeight: 76,
      inRange: { color: ['#1f6feb', '#58a6ff', '#d29922', '#f85149'] },
    },
    series: [{
      type: 'scatter', data: pts,
      symbolSize: (v) => Math.max(6, Math.min(26, 5 + (v[2] || 0) * 3.4)),
      itemStyle: { opacity: .82, borderColor: '#0d1117', borderWidth: 1 },
    }],
  });
}

function renderBar(rows) {
  const top = rows.slice(0, 20).slice().reverse();
  chart('chartBar', {
    ...baseOpt(),
    grid: { left: 76, right: 38, top: 14, bottom: 26 },
    tooltip: { ...baseOpt().tooltip, formatter: (p) => `${p.name}<br/>综合得分：${fmt(p.value, 1)}` },
    xAxis: { ...AXIS, type: 'value' },
    yAxis: { ...AXIS, type: 'category', data: top.map((r) => r.name),
             axisLabel: { color: '#8b949e', fontSize: 10.5 } },
    series: [{
      type: 'bar', data: top.map((r) => Number(r.elastic_score || 0).toFixed(1)),
      itemStyle: {
        borderRadius: [0, 4, 4, 0],
        color: (p) => {
          const v = Number(top[p.dataIndex].elastic_score || 0);
          return v >= 70 ? '#f85149' : v >= 50 ? '#d29922' : v >= 30 ? '#58a6ff' : '#6e7681';
        },
      },
      barMaxWidth: 15,
      label: { show: true, position: 'right', color: '#8b949e', fontSize: 10 },
    }],
  });
}

function renderPie(rows) {
  const dist = {};
  rows.forEach((r) => { dist[r.shape || '数据不足'] = (dist[r.shape || '数据不足'] || 0) + 1; });
  const colorMap = { '潜在变盘': '#d29922', '趋势进行中': '#f85149', '区间震荡': '#58a6ff' };
  const data = Object.entries(dist).map(([k, v]) => ({
    name: k, value: v, itemStyle: { color: colorMap[k] || '#6e7681' },
  }));
  chart('chartPie', {
    ...baseOpt(),
    tooltip: { ...baseOpt().tooltip, formatter: '{b}：{c} 只 ({d}%)' },
    legend: { bottom: 4, textStyle: { color: '#8b949e', fontSize: 11 },
              itemWidth: 11, itemHeight: 11 },
    series: [{
      type: 'pie', radius: ['42%', '68%'], center: ['50%', '44%'], data,
      avoidLabelOverlap: true,
      label: { color: '#8b949e', fontSize: 11, formatter: '{b}\n{c} 只' },
      labelLine: { lineStyle: { color: '#30363d' } },
      itemStyle: { borderColor: '#0d1117', borderWidth: 2 },
    }],
  });
}

const SHAPE_CLS = { '潜在变盘': 'turn', '趋势进行中': 'trend', '区间震荡': 'range' };

function renderTable(rows) {
  const cols = [
    ['rank', '排名'], ['code', '代码'], ['name', '名称'], ['price', '现价'],
    ['pct_chg', '涨跌幅%'], ['float_mv', '流通市值(亿)'], ['beta', 'β'],
    ['ann_vol', '年化波动%'], ['atr_pct', 'ATR%'], ['amplitude', '振幅%'],
    ['turnover', '换手率%'], ['volume_ratio', '量比'], ['bb_pct', '带宽分位'],
    ['range_amp', '区间幅度%'], ['ret60', '60日涨跌%'],
    ['elastic_score', '综合得分'], ['shape', '形态'],
  ];
  $('#tblHead').innerHTML = cols.map(([, t]) => `<th>${t}</th>`).join('');
  $('#tblBody').innerHTML = rows.map((r) => {
    const td = (k, d = 2, colorize = false) =>
      `<td class="${colorize ? cls(r[k]) : ''}">${fmt(r[k], d)}</td>`;
    return `<tr>
      <td>${r.rank ?? '-'}</td>
      <td class="code">${r.code}</td>
      <td class="nm">${r.name}</td>
      <td>${fmt(r.price)}</td>
      ${td('pct_chg', 2, true)}${td('float_mv', 1)}${td('beta')}${td('ann_vol', 1)}
      ${td('atr_pct')}${td('amplitude')}${td('turnover')}${td('volume_ratio')}
      ${td('bb_pct', 0)}${td('range_amp', 1)}${td('ret60', 2, true)}
      <td><span class="score-bar">${fmt(r.elastic_score, 1)}</span></td>
      <td><span class="tag ${SHAPE_CLS[r.shape] || 'range'}">${r.shape || '—'}</span></td>
    </tr>`;
  }).join('');
}

/* ---------- 导出 ---------- */
$('#btnExport').addEventListener('click', () => {
  if (!state.result) return;
  const d = state.result;
  try {
    if (state.mode === 'static') {
      const fn = exportXlsx(d.rows, d.params, d.meta);
      toast('已导出：' + fn, 'ok');
      return;
    }
    // API 模式走后端
    fetch('/api/export', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        rows: d.rows, params: d.params, summary: d.summary, weights: d.weights,
      }),
    }).then((r) => r.json()).then((x) => {
      if (!x.url) throw new Error(x.detail || '导出失败');
      const a = document.createElement('a');
      a.href = x.url; a.download = x.filename;
      document.body.appendChild(a); a.click(); a.remove();
      toast('已导出：' + x.filename, 'ok');
    }).catch((e) => toast('导出失败：' + e.message, 'err'));
  } catch (e) {
    toast('导出失败：' + e.message, 'err');
  }
});

/* ---------- 单只诊断 ---------- */
$('#btnDiag').addEventListener('click', () => {
  const code = $('#inpCode').value.trim();
  if (code) runDiagnose(code);
});
$('#inpCode').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && e.target.value.trim()) runDiagnose(e.target.value.trim());
});
$$('.chip').forEach((c) => c.addEventListener('click', () => {
  $('#inpCode').value = c.dataset.code;
  runDiagnose(c.dataset.code);
}));

async function runDiagnose(code) {
  code = code.replace(/\D/g, '').padStart(6, '0');
  $('#diagEmpty').classList.add('hidden');
  try {
    if (state.mode === 'static') return diagStatic(code);
    const res = await fetch('/api/diagnose', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code, bench: $('#selDiagBench').value, hist_days: 300 }),
    });
    const d = await res.json();
    if (!res.ok) throw new Error(d.detail || '诊断失败');
    renderDiag({
      code: d.code, name: d.name, price: d.price, pct_chg: d.pct_chg,
      float_mv: d.float_mv, shape: d.shape, bars: d.bars,
      metrics: d.metrics, radar: d.radar, series: d.series, bench: true,
    });
    $('#diagResult').classList.remove('hidden');
  } catch (e) {
    toast('诊断失败：' + e.message, 'err');
    $('#diagEmpty').classList.remove('hidden');
  }
}

function diagStatic(code) {
  const row = state.snapshot.rows.find((r) => r.code === code);
  if (!row) {
    toast(`快照中无 ${code}（仅覆盖 ${state.snapshot.meta.pools.join('+')}）`, 'err');
    $('#diagEmpty').classList.remove('hidden');
    return;
  }
  const m = {
    beta: row.beta, ann_vol: row.ann_vol, atr_pct: row.atr_pct,
    amplitude: row.amplitude, turnover: row.turnover, volume_ratio: row.volume_ratio,
    bb_width: row.bb_width, bb_pct: row.bb_pct, range_amp: row.range_amp, ret60: row.ret60,
  };
  const radar = {
    '市场敏感度 β': _scale(row.beta, 0.5, 2.5),
    '年化波动率': _scale(row.ann_vol, 15, 80),
    '振幅': _scale(row.amplitude, 1, 8),
    '换手率': _scale(row.turnover, 0.3, 6),
    '带宽分位': _scale(row.bb_pct, 0, 100),
  };
  // 静态模式用「全池百分位」替代走势图
  const pcts = percentileInPool(row);
  renderDiag({
    code: row.code, name: row.name, price: row.price, pct_chg: row.pct_chg,
    float_mv: row.float_mv, shape: shapeSignal(row), bars: state.snapshot.meta.hist_days,
    metrics: m, radar, poolPct: pcts, bench: false, pool: row.pool,
  });
  $('#diagResult').classList.remove('hidden');
}

function _scale(v, lo, hi) {
  if (!isNum(v)) return 0;
  return Math.max(0, Math.min(100, ((v - lo) / (hi - lo)) * 100));
}

/* 该股各指标在全池中的百分位 */
function percentileInPool(row) {
  const keys = [
    ['beta', 'β'], ['ann_vol', '年化波动率'], ['amplitude', '振幅'],
    ['turnover', '换手率'], ['atr_pct', 'ATR%'], ['range_amp', '区间幅度'],
  ];
  const all = state.snapshot.rows;
  return keys.map(([k, label]) => {
    const v = row[k];
    if (!isNum(v)) return { label, pct: 0 };
    const arr = all.map((r) => r[k]).filter(isNum).sort((a, b) => a - b);
    const below = arr.filter((x) => x <= v).length;
    return { label, pct: Math.round((below / arr.length) * 100) };
  });
}

function renderDiag(d) {
  $('#diagHead').innerHTML = `
    <h2>${d.name} <span class="cd">${d.code}</span></h2>
    <div class="muted" style="margin-top:5px">
      现价 <b class="${cls(d.pct_chg)}">${fmt(d.price)}</b>
      <span class="${cls(d.pct_chg)}">${isNum(d.pct_chg) && d.pct_chg > 0 ? '+' : ''}${fmt(d.pct_chg)}%</span>
      · 流通市值 ${fmt(d.float_mv, 1)} 亿
      · 形态 <span class="tag ${SHAPE_CLS[d.shape] || 'range'}">${d.shape}</span>
      ${d.pool ? `· ${d.pool}` : ''}
      · 样本 ${d.bars} 个交易日
    </div>`;

  const rk = Object.keys(d.radar || {});
  chart('chartRadar', {
    ...baseOpt(),
    tooltip: baseOpt().tooltip,
    radar: {
      indicator: rk.map((k) => ({ name: k, max: 100 })),
      axisName: { color: '#8b949e', fontSize: 11 },
      splitLine: { lineStyle: { color: '#30363d' } },
      splitArea: { areaStyle: { color: ['#161b22', '#1c2128'] } },
      axisLine: { lineStyle: { color: '#30363d' } },
      radius: '66%', center: ['50%', '54%'],
    },
    series: [{
      type: 'radar', data: [{
        value: rk.map((k) => d.radar[k]), name: '指标强度',
        areaStyle: { color: 'rgba(88,166,255,.26)' },
        lineStyle: { color: '#58a6ff', width: 2 },
        itemStyle: { color: '#58a6ff' },
      }],
    }],
  });

  // 右图：有走势画走势（API），否则画全池百分位（静态）
  if (d.series && d.series.length) {
    $('#lblLineChart').textContent = '近 120 日收盘走势';
    const xs = d.series.map((s) => s.d);
    chart('chartLine', {
      ...baseOpt(),
      title: { text: '近 120 日收盘走势', textStyle: { color: '#8b949e', fontSize: 12 } },
      grid: { left: 52, right: 18, top: 40, bottom: 46 },
      tooltip: { ...baseOpt().tooltip, trigger: 'axis' },
      xAxis: { ...AXIS, type: 'category', data: xs, boundaryGap: false,
               axisLabel: { color: '#8b949e', fontSize: 10,
                            interval: Math.max(1, Math.floor(xs.length / 6)) } },
      yAxis: { ...AXIS, type: 'value', scale: true },
      dataZoom: [{ type: 'inside' }],
      series: [{
        type: 'line', data: d.series.map((s) => s.c), smooth: true, symbol: 'none',
        lineStyle: { color: '#58a6ff', width: 1.8 },
        areaStyle: {
          color: new echarts.graphic.LinearGradient(0, 0, 0, 1, [
            { offset: 0, color: 'rgba(88,166,255,.28)' },
            { offset: 1, color: 'rgba(88,166,255,0)' },
          ]),
        },
      }],
    });
  } else if (d.poolPct) {
    $('#lblLineChart').textContent = '各指标在全池中的百分位';
    chart('chartLine', {
      ...baseOpt(),
      grid: { left: 52, right: 24, top: 40, bottom: 46 },
      tooltip: { ...baseOpt().tooltip, formatter: (p) => `${p.name}：全池 ${p.value} 分位` },
      xAxis: { ...AXIS, type: 'category', data: d.poolPct.map((x) => x.label),
               axisLabel: { color: '#8b949e', fontSize: 10, interval: 0, rotate: 24 } },
      yAxis: { ...AXIS, type: 'value', max: 100, name: '分位',
               nameTextStyle: { color: '#8b949e', fontSize: 10 } },
      series: [{
        type: 'bar', data: d.poolPct.map((x) => x.pct),
        barMaxWidth: 30,
        itemStyle: {
          borderRadius: [4, 4, 0, 0],
          color: (p) => {
            const v = d.poolPct[p.dataIndex].pct;
            return v >= 80 ? '#f85149' : v >= 60 ? '#d29922' : v >= 40 ? '#58a6ff' : '#6e7681';
          },
        },
        label: { show: true, position: 'top', color: '#8b949e', fontSize: 10,
                 formatter: '{c}' },
      }],
    });
  }

  const m = d.metrics || {};
  const items = [
    ['β 系数', m.beta, ''], ['年化波动率', m.ann_vol, '%'],
    ['ATR%', m.atr_pct, '%'], ['振幅', m.amplitude, '%'],
    ['换手率', m.turnover, '%'], ['量比', m.volume_ratio, ''],
    ['布林带宽', m.bb_width, ''], ['带宽分位', m.bb_pct, ''],
    ['区间幅度', m.range_amp, '%'], ['近60日涨跌', m.ret60, '%'],
  ];
  $('#diagMetrics').innerHTML = items.map(([k, v, u]) =>
    `<div class="metric"><div class="k">${k}</div>
     <div class="v">${fmt(v)}${u ? `<span style="font-size:12px;color:var(--tx3)">${u}</span>` : ''}</div></div>`
  ).join('');
}

/* ---------- Tab ---------- */
$$('.tab').forEach((t) => t.addEventListener('click', () => {
  $$('.tab').forEach((x) => x.classList.remove('active'));
  $$('.tab-page').forEach((x) => x.classList.remove('active'));
  t.classList.add('active');
  $('#tab-' + t.dataset.tab).classList.add('active');
  setTimeout(() => Object.values(state.charts).forEach((c) => c && c.resize()), 60);
}));

boot();
