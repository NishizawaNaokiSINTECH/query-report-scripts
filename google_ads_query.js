// ============================================================
// 検索クエリ実績レポート（Google広告）
// バージョン: v1.1（前月／当月の2タブ出力）
// 目的: 検索クエリのローデータを毎日取り直してシートへ書き出す。除外KWの判断に使う。
//   COST・CPC・CPA は CONFIG.FEE を掛けた値で出る。FEE を 1 以外にした場合、
//   下流の加工で再度 fee を掛けないこと。
// 取得期間: 前月タブ＝前月1日〜前月末日／当月タブ＝当月1日〜実行日の前日。
//   毎日どちらも取り直してタブを全面置換する。前月ぶんも取り直すのは、月が閉じた後も
//   コンバージョンが遅れて計上され、確定まで数値が動くためである。
// 実行環境: Google広告スクリプト（対象アカウントで作成する）
// 出力先: CONFIG.SHEET_ID のスプレッドシートの CONFIG.TAB_PREV／CONFIG.TAB_CUR タブ（無ければ作成）
// スケジュール: 毎日 11:00〜12:00 を目安にする。LINEヤフー版と同じブックへ書く場合は時間帯を分ける
// 使い方: README.md を参照
// ============================================================

const CONFIG = {
  // 書き出し先スプレッドシートのID（URLの /d/ と /edit の間の文字列）
  SHEET_ID: "ここにスプレッドシートIDを入れる",
  TAB_PREV: "検索クエリ_前月_G",
  TAB_CUR: "検索クエリ_当月_G",

  // fee係数。COST／CPC／CPA にこの係数を掛けて出力する。
  // 1 のままなら管理画面ベース。請求ベースで出したい場合は案件の fee係数を入れる（例: 1.2）
  FEE: 1,

  // 検索広告のみに絞る。search_term_view はデマンドジェネレーションを含まないが、
  // ショッピング等の別タイプは入るため、CTR・CPCの水準を揃えるにはこのフィルタが要る。
  SEARCH_ONLY: true,

  // setValues の1回あたり行数。大きな表を一度に書くと実行時間の上限に当たる。
  WRITE_CHUNK: 2000,

  TIMEZONE: "Asia/Tokyo",
};

const HEADER = [
  "クエリ", "マッチタイプ", "キャンペーン", "広告グループ", "キーワードID", "キーワード",
  "表示回数", "クリック", "CTR", "CPC", "COST", "CV", "CVR", "CPA",
];

function main() {
  if (!/^[A-Za-z0-9_-]{20,}$/.test(CONFIG.SHEET_ID)) {
    throw new Error("CONFIG.SHEET_ID に書き出し先スプレッドシートのIDを入れてください");
  }
  Logger.log(`アカウント: ${AdsApp.currentAccount().getName()} (${AdsApp.currentAccount().getCustomerId()})`);
  const ranges = resolveRanges();

  runOne(CONFIG.TAB_PREV, ranges.prev);
  runOne(CONFIG.TAB_CUR, ranges.cur);

  Logger.log("=== 完了 ===");
}

function runOne(tab, range) {
  if (range.empty) {
    // 毎月1日は「当月1日〜前日」が成立しない。前日ぶんまでは前月タブが持っている。
    // 前日の実行結果をそのまま残すと先月のデータが当月タブに居座るため、空にする。
    Logger.log(`${tab}: 当月の対象日がまだありません。タブを空にします`);
    resetSheet(tab, range);
    return;
  }

  Logger.log(`${tab}: 取得期間 ${range.start} 〜 ${range.end}`);
  const rows = fetchQueries(range.start, range.end);
  if (rows.length === 0) {
    // 0件でタブを消すと、取得に失敗した日に前回の正しいデータまで失われる。
    Logger.log(`${tab}: 取得0件のためタブは更新しません。期間とフィルタを確認してください`);
    return;
  }

  writeSheet(tab, rows, range);
  Logger.log(`${tab}: ${rows.length}行を書き出しました`);
}

// ------------------------------------------------------------
// 期間
// ------------------------------------------------------------

// Ads Script のサーバ時刻はUTCのため、年月日の判定は必ずJSTへ変換してから行う。
// ローカルの getMonth() 等で組むと、JSTの朝がUTCでは前日になり月初で1か月ずれる。
function resolveRanges() {
  const now = new Date();
  const y = Number(Utilities.formatDate(now, CONFIG.TIMEZONE, "yyyy"));
  const m = Number(Utilities.formatDate(now, CONFIG.TIMEZONE, "MM"));
  const yesterday = Utilities.formatDate(new Date(now.getTime() - 86400000), CONFIG.TIMEZONE, "yyyy-MM-dd");

  const prevY = m === 1 ? y - 1 : y;
  const prevM = m === 1 ? 12 : m - 1;
  const prevStart = `${prevY}-${pad2(prevM)}-01`;
  const curStart = `${y}-${pad2(m)}-01`;

  return {
    prev: { label: "前月", start: prevStart, end: lastDayOf(prevY, prevM), empty: false },
    cur: { label: "当月", start: curStart, end: yesterday, empty: yesterday < curStart },
  };
}

function pad2(n) {
  return ("0" + n).slice(-2);
}

// Date.UTC の month は0始まりなので、mをそのまま渡すと翌月を指す。
// そこへ day=0 を与えると当月の最終日になる。うるう年も月の大小も自動で解決する。
function lastDayOf(y, m) {
  return Utilities.formatDate(new Date(Date.UTC(y, m, 0)), "UTC", "yyyy-MM-dd");
}

// ------------------------------------------------------------
// 取得
// ------------------------------------------------------------

function fetchQueries(start, end) {
  const where = [`segments.date BETWEEN '${start}' AND '${end}'`];
  if (CONFIG.SEARCH_ONLY) where.push("campaign.advertising_channel_type = 'SEARCH'");

  // segments.date を選ばないことで、APIが期間全体で合算した行を返す。
  const query = `
    SELECT search_term_view.search_term,
           segments.search_term_match_type,
           campaign.name,
           ad_group.name,
           segments.keyword.ad_group_criterion,
           segments.keyword.info.text,
           metrics.impressions,
           metrics.clicks,
           metrics.cost_micros,
           metrics.conversions
    FROM search_term_view
    WHERE ${where.join(" AND ")}`;

  const iter = AdsApp.search(query);
  const map = {};
  let seen = 0;
  while (iter.hasNext()) {
    const r = iter.next();
    seen++;

    const seg = r.segments || {};
    const kw = seg.keyword || {};
    const q = (r.searchTermView && r.searchTermView.searchTerm) || "";
    const match = matchTypeLabel(seg.searchTermMatchType);
    const cp = (r.campaign && r.campaign.name) || "";
    const ag = (r.adGroup && r.adGroup.name) || "";
    const kwId = criterionId(kw.adGroupCriterion);
    const kwText = (kw.info && kw.info.text) || "";

    // キャンペーン名や広告グループ名に区切り文字が含まれても衝突しないキーにする。
    const key = JSON.stringify([q, match, cp, ag, kwId]);
    if (!map[key]) {
      map[key] = { q: q, match: match, cp: cp, ag: ag, kwId: kwId, kwText: kwText,
                   imp: 0, clicks: 0, costMicros: 0, conv: 0 };
    }
    const a = map[key];
    const m = r.metrics || {};
    a.imp += Number(m.impressions || 0);
    a.clicks += Number(m.clicks || 0);
    // マイクロ単位の整数のまま積み、円への変換は出力時に1回だけ行う。
    // 行ごとに割ってから足すと浮動小数の誤差が蓄積し、管理画面との突合で端数がずれる。
    a.costMicros += Number(m.costMicros || 0);
    a.conv += Number(m.conversions || 0);
  }

  const rows = Object.keys(map).map(k => map[k]);
  // CV降順 → COST降順。
  rows.sort((a, b) => b.conv - a.conv || b.costMicros - a.costMicros || b.imp - a.imp);

  Logger.log(`  取得: 生${seen}行 → 合算後${rows.length}行`);
  return rows;
}

// segments.keyword.ad_group_criterion は
// customers/{顧客ID}/adGroupCriteria/{広告グループID}~{条件ID} のリソース名で返る。
// 管理画面やレポートの「キーワードID」は末尾の条件IDにあたる。
function criterionId(resourceName) {
  const s = String(resourceName || "");
  const i = s.lastIndexOf("~");
  return i === -1 ? "" : s.substring(i + 1);
}

function matchTypeLabel(v) {
  const m = {
    EXACT: "完全一致",
    NEAR_EXACT: "完全一致（類似）",
    PHRASE: "フレーズ一致",
    NEAR_PHRASE: "フレーズ一致（類似）",
    BROAD: "インテントマッチ",
  };
  const k = String(v || "").toUpperCase();
  return m[k] || String(v || "");
}

// ------------------------------------------------------------
// 書き出し
// ------------------------------------------------------------

function writeSheet(tab, rows, range) {
  const sheet = getOrCreate(tab);
  sheet.clear();
  fitGrid(sheet, HEADER.length, rows.length + 10);

  sheet.getRange(1, 1).setValue(noteLine(range));
  sheet.getRange(2, 1, 1, HEADER.length).setValues([HEADER]);

  // クエリ・キーワードID・キーワードは書き込み前にテキスト書式にする。
  // 数字だけのクエリやIDが数値へ変換され、桁落ちや指数表記になるのを防ぐ。
  applyTextColumns(sheet, rows.length);

  const fee = CONFIG.FEE;
  const values = rows.map(a => {
    const cost = (a.costMicros / 1000000) * fee;
    return [
      a.q, a.match, a.cp, a.ag, a.kwId, a.kwText,
      a.imp, a.clicks,
      a.imp ? a.clicks / a.imp : 0,
      a.clicks ? cost / a.clicks : 0,
      cost, a.conv,
      a.clicks ? a.conv / a.clicks : 0,
      a.conv ? cost / a.conv : 0,
    ];
  });

  // clear済みのタブへ分割して書くため、途中で落ちるとその日のデータが欠けた状態で残る。
  // 黙って欠けると気づけないので、ログに残したうえで実行を失敗として終わらせる。
  try {
    for (let i = 0; i < values.length; i += CONFIG.WRITE_CHUNK) {
      const chunk = values.slice(i, i + CONFIG.WRITE_CHUNK);
      sheet.getRange(3 + i, 1, chunk.length, HEADER.length).setValues(chunk);
    }
  } catch (e) {
    Logger.log("★ 書き込みが中断しました。タブが不完全な可能性があります: " + e);
    throw e;
  }

  applyFormat(sheet, values.length);
}

// 対象日がまだ無い当月タブ用。ヘッダーだけ残し、注記で理由が読めるようにする。
function resetSheet(tab, range) {
  const sheet = getOrCreate(tab);
  sheet.clear();
  fitGrid(sheet, HEADER.length, 10);
  sheet.getRange(1, 1).setValue(noteLine(range));
  sheet.getRange(2, 1, 1, HEADER.length).setValues([HEADER]);
  applyFormat(sheet, 0);
}

function noteLine(range) {
  const period = range.empty
    ? `${range.label} 対象日なし（前日は前月末日のため前月タブを参照）`
    : `集計期間 ${range.start} 〜 ${range.end}（${range.label}）`;
  return `${period}／fee係数 ${CONFIG.FEE}` +
         `${CONFIG.FEE === 1 ? "（管理画面ベース）" : "（請求ベース）"}` +
         `${CONFIG.SEARCH_ONLY ? "／検索広告のみ" : "／全キャンペーンタイプ"}` +
         `／出力 ${Utilities.formatDate(new Date(), CONFIG.TIMEZONE, "yyyy-MM-dd HH:mm")}`;
}

function getOrCreate(tab) {
  const ss = SpreadsheetApp.openById(CONFIG.SHEET_ID);
  let sheet = ss.getSheetByName(tab);
  if (!sheet) {
    sheet = ss.insertSheet(tab);
    Logger.log(`タブ新規作成: ${tab}`);
  }
  return sheet;
}

function applyTextColumns(sheet, n) {
  if (n === 0) return;
  try {
    sheet.getRange(3, 1, n, 1).setNumberFormat("@");  // クエリ
    sheet.getRange(3, 5, n, 2).setNumberFormat("@");  // キーワードID・キーワード
  } catch (e) { Logger.log("書式スキップ テキスト列: " + e); }
}

function applyFormat(sheet, n) {
  try {
    sheet.getRange(2, 1, 1, HEADER.length)
      .setFontWeight("bold").setBackground("#262626").setFontColor("#ffffff");
    sheet.setFrozenRows(2);
    sheet.setFrozenColumns(2);
    sheet.setColumnWidth(1, 260);
    sheet.setColumnWidth(2, 110);
    sheet.setColumnWidth(3, 190);
    sheet.setColumnWidth(4, 150);
    sheet.setColumnWidth(6, 200);
  } catch (e) { Logger.log("書式スキップ ヘッダ: " + e); }

  if (n === 0) return;

  try {
    sheet.getRange(3, 7, n, 2).setNumberFormat("#,##0");      // 表示回数・クリック
    sheet.getRange(3, 9, n, 1).setNumberFormat("0.00%");      // CTR
    sheet.getRange(3, 10, n, 2).setNumberFormat("¥#,##0");    // CPC・COST
    sheet.getRange(3, 12, n, 1).setNumberFormat("#,##0.00");  // CV
    sheet.getRange(3, 13, n, 1).setNumberFormat("0.00%");     // CVR
    sheet.getRange(3, 14, n, 1).setNumberFormat("¥#,##0");    // CPA
    sheet.getRange(2, 1, n + 1, HEADER.length)
      .setBorder(true, true, true, true, true, true, "#bfbfbf", SpreadsheetApp.BorderStyle.SOLID);
  } catch (e) { Logger.log("書式スキップ 本文: " + e); }
}

// グリッドを必要な寸法へ合わせる。増やすだけにすると、行数がピークだった日の寸法が
// 恒久的に残り、同じブックに同居する他タブと合わせて1ブック1,000万セルの上限に効く。
function fitGrid(sheet, needCols, needRows) {
  const addCols = needCols - sheet.getMaxColumns();
  if (addCols > 0) sheet.insertColumnsAfter(sheet.getMaxColumns(), addCols);

  const keep = Math.max(needRows, 1);
  const diff = keep - sheet.getMaxRows();
  if (diff > 0) {
    sheet.insertRowsAfter(sheet.getMaxRows(), diff);
  } else if (diff < 0) {
    sheet.deleteRows(keep + 1, -diff);
  }
}
