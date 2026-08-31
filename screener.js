/* 前端筛选引擎：过滤 / 归一化打分 / 排序 / 导出
   与后端 indicators.py 的口径保持一致 */
'use strict';

/* 风格预设权重（与后端 STYLE_PRESETS 一致） */
const WEIGHTS = {
  balanced: { beta: 0.25, ann_vol: 0.30, amplitude: 0.10, turnover: 0.25, bb_pct: 0.10 },
  swing:    { beta: 0.20, ann_vol: 0.25, amplitude: 0.10, turnover: 0.35, bb_pct: 0.10 },
  trend:    { beta: 0.35, ann_vol: 0.30, amplitude: 0.10, turnover: 0.15, bb_pct: 0.10 },
  leader:   { beta: 0.30, ann_vol: 0.25, amplitude: 0.10, turnover: 0.30, bb_pct: 0.05 },
};

/* 用 var 而非 const：该函数会被 app.js 复用，避免两个 <script>
   共享全局作用域时重复 const 声明导致 SyntaxError */
var isNum = (v) => v !== null && v !== undefined && typeof v === 'number' && isFinite(v);

/* Min-Max 归一化到 0~100；常量列一律 50；null 保持 null */
function normalize(vals) {
  const valid = vals.filter(isNum);
  if (!valid.length) return vals.map(() => null);
  const lo = Math.min(...valid);
  const hi = Math.max(...valid);
  if (hi === lo) return vals.map((v) => (isNum(v) ? 50 : null));
  return vals.map((v) => (isNum(v) ? ((v - lo) / (hi - lo)) * 100 : null));
}

/* 形态信号：带宽分位 ≤25 潜在变盘；≥75 趋势进行中 */
function shapeSignal(row) {
  const p = row.bb_pct;
  if (!isNum(p)) return '数据不足';
  if (p <= 25) return '潜在变盘';
  if (p >= 75) return '趋势进行中';
  return '区间震荡';
}

/* 主筛选：过滤 → 打分 → 排序 → 截断 */
function screenRows(allRows, params) {
  const w = WEIGHTS[params.style] || WEIGHTS.balanced;

  // 1) 股票池
  let rows = allRows;
  if (params.pool && params.pool !== '全部') {
    rows = rows.filter((r) => r.pool === params.pool);
  }

  // 2) 硬过滤（null 视为不达标，与后端一致）
  rows = rows.filter((r) => {
    if (params.beta_min > 0 && !(isNum(r.beta) && r.beta >= params.beta_min)) return false;
    if (params.beta_max > 0 && !(isNum(r.beta) && r.beta <= params.beta_max)) return false;
    if (!(isNum(r.ann_vol) && r.ann_vol >= params.vol_min)) return false;
    if (!(isNum(r.turnover) && r.turnover >= params.turnover_min)) return false;
    if (params.amp_min > 0 && !(isNum(r.amplitude) && r.amplitude >= params.amp_min)) return false;
    if (params.volratio_min > 0 &&
        !(isNum(r.volume_ratio) && r.volume_ratio >= params.volratio_min)) return false;
    if (isNum(r.float_mv) &&
        (r.float_mv < params.mv_min || r.float_mv > params.mv_max)) return false;
    return true;
  });

  if (!rows.length) return { rows: [], relaxed: false };

  // 3) 归一化打分（β 先截断到 3，与后端一致）
  const sBeta  = normalize(rows.map((r) => (isNum(r.beta) ? Math.min(r.beta, 3) : null)));
  const sVol   = normalize(rows.map((r) => r.ann_vol));
  const sAmp   = normalize(rows.map((r) => r.amplitude));
  const sTurn  = normalize(rows.map((r) => r.turnover));
  const sBb    = normalize(rows.map((r) => r.bb_pct));

  const scored = rows.map((r, i) => ({
    ...r,
    score_beta: sBeta[i], score_vol: sVol[i], score_amp: sAmp[i],
    score_turnover: sTurn[i], score_bb: sBb[i],
    // 缺维度记 0，避免整条记录失效
    elastic_score:
      (sBeta[i] || 0) * w.beta +
      (sVol[i]  || 0) * w.ann_vol +
      (sAmp[i]  || 0) * w.amplitude +
      (sTurn[i] || 0) * w.turnover +
      (sBb[i]   || 0) * w.bb_pct,
    shape: shapeSignal(r),
  }));

  scored.sort((a, b) => (b.elastic_score || 0) - (a.elastic_score || 0));
  const top = scored.slice(0, params.top_n);
  top.forEach((r, i) => { r.rank = i + 1; });

  return { rows: top, relaxed: false, matched: scored.length };
}

/* 汇总统计 */
function summarize(rows) {
  const avg = (k) => {
    const v = rows.map((r) => r[k]).filter(isNum);
    return v.length ? v.reduce((a, b) => a + b, 0) / v.length : 0;
  };
  return {
    avg_beta: avg('beta'), avg_vol: avg('ann_vol'),
    avg_turnover: avg('turnover'), avg_amp: avg('amplitude'),
  };
}

/* ---------- Excel 导出（多 Sheet + 冻结首行 + 筛选） ---------- */
const COLS = [
  ['rank', '排名'], ['code', '代码'], ['name', '名称'], ['pool', '所属池'],
  ['price', '现价'], ['pct_chg', '涨跌幅(%)'], ['float_mv', '流通市值(亿)'],
  ['beta', 'β系数'], ['ann_vol', '年化波动率(%)'], ['atr_pct', 'ATR%(%)'],
  ['amplitude', '振幅(%)'], ['turnover', '换手率(%)'], ['volume_ratio', '量比'],
  ['bb_width', '布林带宽'], ['bb_pct', '带宽分位'], ['range_amp', '区间幅度(%)'],
  ['ret60', '近60日涨跌(%)'], ['elastic_score', '综合得分'], ['shape', '形态信号'],
];

const SCORE_COLS = [
  ['code', '代码'], ['name', '名称'],
  ['score_beta', 'β得分'], ['score_vol', '波动率得分'], ['score_amp', '振幅得分'],
  ['score_turnover', '换手率得分'], ['score_bb', '带宽得分'],
  ['elastic_score', '综合得分'],
];

function _frozen(ws, nCol) {
  ws['!views'] = [{
    xSplit: 0, ySplit: 1, topLeftCell: 'A2',
    activePane: 'bottomRight', state: 'frozen',
  }];
  if (nCol > 0) {
    ws['!autofilter'] = { ref: XLSX.utils.encode_range({ s: { c: 0, r: 0 }, e: { c: nCol - 1, r: 0 } }) };
  }
}

function _widths(ws, nCol) {
  ws['!cols'] = Array.from({ length: nCol }, (_, i) => ({
    wch: Math.max(11, Math.min(20, i * 2 + 8)),
  }));
}

function exportXlsx(rows, params, meta) {
  if (typeof XLSX === 'undefined') throw new Error('Excel 库未加载');
  const wb = XLSX.utils.book_new();

  // Sheet1 标的清单
  const cols = COLS.filter(([k]) => rows.some((r) => r[k] !== undefined));
  const aoa = [cols.map(([, t]) => t)];
  rows.forEach((r) => aoa.push(cols.map(([k]) => {
    const v = r[k];
    return isNum(v) ? Number(v.toFixed(2)) : (v ?? '');
  })));
  const ws1 = XLSX.utils.aoa_to_sheet(aoa);
  _frozen(ws1, cols.length); _widths(ws1, cols.length);
  XLSX.utils.book_append_sheet(wb, ws1, '标的清单');

  // Sheet2 分项得分
  const sCols = SCORE_COLS.filter(([k]) => rows.some((r) => r[k] !== undefined));
  const aoa2 = [sCols.map(([, t]) => t)];
  rows.forEach((r) => aoa2.push(sCols.map(([k]) => {
    const v = r[k];
    return isNum(v) ? Number(v.toFixed(2)) : (v ?? '');
  })));
  const ws2 = XLSX.utils.aoa_to_sheet(aoa2);
  _frozen(ws2, sCols.length); _widths(ws2, sCols.length);
  XLSX.utils.book_append_sheet(wb, ws2, '分项得分');

  // Sheet3 形态分布
  const dist = {};
  rows.forEach((r) => { dist[r.shape] = (dist[r.shape] || 0) + 1; });
  const aoa3 = [['形态信号', '标的数', '占比(%)']];
  Object.entries(dist).sort((a, b) => b[1] - a[1]).forEach(([k, v]) => {
    aoa3.push([k, v, Number(((v / rows.length) * 100).toFixed(1))]);
  });
  const ws3 = XLSX.utils.aoa_to_sheet(aoa3);
  _frozen(ws3, 3); _widths(ws3, 3);
  XLSX.utils.book_append_sheet(wb, ws3, '形态分布');

  // Sheet4 筛选参数
  const s = summarize(rows);
  const labels = {
    pool: '股票池', style: '风格预设', beta_min: 'β下限', beta_max: 'β上限',
    vol_min: '年化波动率下限(%)', amp_min: '振幅下限(%)',
    turnover_min: '换手率下限(%)', volratio_min: '量比下限',
    mv_min: '流通市值下限(亿)', mv_max: '流通市值上限(亿)', top_n: '返回前N只',
  };
  const aoa4 = [['参数', '取值']];
  Object.entries(labels).forEach(([k, t]) => {
    if (params[k] !== undefined) aoa4.push([t, String(params[k])]);
  });
  aoa4.push(['综合权重', JSON.stringify(WEIGHTS[params.style] || WEIGHTS.balanced)]);
  aoa4.push(['均值·β', s.avg_beta.toFixed(3)]);
  aoa4.push(['均值·年化波动率', s.avg_vol.toFixed(2)]);
  aoa4.push(['均值·换手率', s.avg_turnover.toFixed(2)]);
  aoa4.push(['均值·振幅', s.avg_amp.toFixed(2)]);
  if (meta) {
    aoa4.push(['数据生成时间', meta.generated_at || '']);
    aoa4.push(['数据来源', meta.data_source || '']);
    aoa4.push(['β基准', meta.benchmark || '']);
  }
  aoa4.push(['导出时间', new Date().toLocaleString('zh-CN')]);
  const ws4 = XLSX.utils.aoa_to_sheet(aoa4);
  _frozen(ws4, 2); _widths(ws4, 2);
  XLSX.utils.book_append_sheet(wb, ws4, '筛选参数');

  const wbout = XLSX.write(wb, { bookType: 'xlsx', type: 'array' });
  const blob = new Blob([wbout], {
    type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  });
  const now = new Date();
  const ts = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}` +
             `${String(now.getDate()).padStart(2, '0')}_` +
             `${String(now.getHours()).padStart(2, '0')}${String(now.getMinutes()).padStart(2, '0')}`;
  const filename = `高弹性标的筛选_${ts}.xlsx`;

  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 500);
  return filename;
}

/* ============ 自选股 ============ */

/* A 股代码合法性：6 位数字，首位 0/3/4/6/8（沪深主板/创业/科创/北交所） */
function isValidCode(c) {
  return /^[0-9]{6}$/.test(c) && '03468'.indexOf(c[0]) >= 0;
}

/**
 * 从任意文本提取 A 股代码。
 * 支持：600000 / sh600000 / 600000.SH / SH.600000 / 逗号空格顿号换行分隔 / CSV 表格
 */
function extractCodes(text) {
  if (!text) return [];
  const out = [];
  const seen = new Set();
  // 按分隔符切开，逐段取 6 位连续数字
  const parts = String(text).split(/[^0-9A-Za-z.]+/);
  for (const p of parts) {
    const m = p.match(/([0-9]{6})/);
    if (!m) continue;
    const code = m[1];
    if (!isValidCode(code) || seen.has(code)) continue;
    seen.add(code);
    out.push(code);
  }
  return out;
}

/**
 * 把自选股代码与已有数据匹配。
 * 返回 { matched, missing } —— matched 已打上 pool='自选股'
 */
function matchCustom(codes, rows) {
  const want = new Set(codes);
  const matched = rows
    .filter((r) => want.has(r.code))
    .map((r) => ({ ...r, pool: '自选股' }));
  const found = new Set(matched.map((r) => r.code));
  const missing = codes.filter((c) => !found.has(c));
  return { matched, missing };
}

/* ============ 自选股池（localStorage 持久化） ============ */

const POOL_KEY = 'elastic_custom_pool_v1';

/* 读取池子，返回 [{code, name}]；异常（隐私模式等）返回空数组 */
function loadPool() {
  try {
    const raw = window.localStorage.getItem(POOL_KEY);
    if (!raw) return [];
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr)) return [];
    return arr.filter((x) => x && isValidCode(x.code))
      .map((x) => ({ code: x.code, name: x.name || '' }));
  } catch (e) {
    return [];
  }
}

/* 保存池子；异常静默（返回是否成功） */
function savePool(pool) {
  try {
    window.localStorage.setItem(POOL_KEY, JSON.stringify(pool));
    return true;
  } catch (e) {
    return false;
  }
}

/**
 * 合并导入：additions 为 [{code, name?}]。
 * 已存在的更新名称（若有），不存在的追加。返回新池子（新数组）。
 */
function mergePool(pool, additions) {
  const map = new Map(pool.map((x) => [x.code, { ...x }]));
  for (const a of additions || []) {
    if (!a || !isValidCode(a.code)) continue;
    const cur = map.get(a.code);
    if (cur) {
      if (a.name) cur.name = a.name;
    } else {
      map.set(a.code, { code: a.code, name: a.name || '' });
    }
  }
  return Array.from(map.values());
}

/* 从池子删除一个代码，返回新池子 */
function removeFromPool(pool, code) {
  return pool.filter((x) => x.code !== code);
}

/* 清空池子（返回空数组并持久化） */
function clearPool() {
  savePool([]);
  return [];
}

/* 池子内代码列表 */
function poolCodes(pool) {
  return (pool || []).map((x) => x.code);
}

/* 暴露给 app.js 复用 */
window.isNum = isNum;
window.isValidCode = isValidCode;
window.extractCodes = extractCodes;
window.loadPool = loadPool;
window.savePool = savePool;
window.mergePool = mergePool;
window.removeFromPool = removeFromPool;
window.clearPool = clearPool;
window.poolCodes = poolCodes;
