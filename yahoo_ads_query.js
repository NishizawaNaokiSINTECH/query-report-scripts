// ============================================================
// 検索クエリ実績レポート（LINEヤフー広告）
// バージョン: v1.1（前月／当月の2タブ出力）
// 目的: 検索クエリのローデータを毎日取り直してシートへ書き出す。除外KWの判断に使う。
//   COST・CPC・CPA は CONFIG.FEE を掛けた値で出る。FEE を 1 以外にした場合、
//   下流の加工で再度 fee を掛けないこと。
// 取得期間: 前月タブ＝前月1日〜前月末日／当月タブ＝当月1日〜実行日の前日。
//   毎日どちらも取り直してタブを全面置換する。前月ぶんも取り直すのは、月が閉じた後も
//   コンバージョンが遅れて計上され、確定まで数値が動くためである。
// 実行環境: LINEヤフー広告スクリプト（対象の検索広告アカウントで作成する）
// 出力先: CONFIG.SHEET_ID のスプレッドシートの CONFIG.TAB_PREV／CONFIG.TAB_CUR タブ（無ければ作成）
// スケジュール: 毎日 13:00〜14:00 を目安にする。Google版と同じブックへ書く場合は時間帯を分ける
// 対象範囲: 検索広告（YSA）のみ。ディスプレイ広告（YDA）は AdsUtilities.getSearchReport の
//   対象外のため本スクリプトでは取得しない。
// 使い方: README.md を参照
//
// LINEヤフー広告スクリプトの SpreadsheetApp には次の制約がある。
//   - setValues() が Range を返さないため、書式系はメソッドチェーンで書けない
//   - Range.setValue()（単数）が存在しない。1セルでも setValues([[値]]) を使う
// ============================================================

var CONFIG = {
  // 書き出し先スプレッドシートのID（URLの /d/ と /edit の間の文字列）
  SHEET_ID: "ここにスプレッドシートIDを入れる",
  TAB_PREV: "検索クエリ_前月_Y",
  TAB_CUR: "検索クエリ_当月_Y",

  // fee係数。COST／CPC／CPA にこの係数を掛けて出力する。
  // 1 のままなら管理画面ベース。請求ベースで出したい場合は案件の fee係数を入れる（例: 1.2）
  FEE: 1,

  REPORT_TYPE: "SEARCH_QUERY",

  // マッチタイプの項目名。2026-09-23 の実行で確定済み。
  // 空にすると MATCH_TYPE_FIELD_CANDIDATES を順に試して自動判定する。
  MATCH_TYPE_FIELD: "SEARCH_QUERY_MATCH_TYPE",

  WRITE_CHUNK: 2000,
  TIMEZONE: "Asia/Tokyo",
};

var MATCH_TYPE_FIELD_CANDIDATES = ["SEARCH_QUERY_MATCH_TYPE", "MATCH_TYPE", "KEYWORD_MATCH_TYPE"];

// 前月と当月で2回取得するため、1度特定した項目名は実行中ずっと使い回す。
var RESOLVED_MATCH_FIELD = "";

var HEADER = [
  "クエリ", "マッチタイプ", "キャンペーン", "広告グループ", "キーワードID", "キーワード",
  "表示回数", "クリック", "CTR", "CPC", "COST", "CV", "CVR", "CPA"
];

function main() {
  if (!/^[A-Za-z0-9_-]{20,}$/.test(CONFIG.SHEET_ID)) {
    throw new Error("CONFIG.SHEET_ID に書き出し先スプレッドシートのIDを入れてください");
  }
  Logger.log("アカウントID: " + AdsUtilities.getCurrentAccountId());
  var ranges = resolveRanges();

  runOne(CONFIG.TAB_PREV, ranges.prev);
  runOne(CONFIG.TAB_CUR, ranges.cur);

  Logger.log("=== 完了 ===");
}

function runOne(tab, range) {
  if (range.empty) {
    // 毎月1日は「当月1日〜前日」が成立しない。前日ぶんまでは前月タブが持っている。
    // 前日の実行結果をそのまま残すと先月のデータが当月タブに居座るため、空にする。
    Logger.log(tab + ": 当月の対象日がまだありません。タブを空にします");
    resetSheet(tab, range);
    return;
  }

  Logger.log(tab + ": 取得期間 " + range.start + " 〜 " + range.end);
  var rows = fetchQueries(range.start, range.end);
  if (rows.length === 0) {
    // 0件でタブを消すと、取得に失敗した日に前回の正しいデータまで失われる。
    Logger.log(tab + ": 取得0件のためタブは更新しません。期間とフィールド名を確認してください");
    return;
  }

  writeSheet(tab, rows, range);
  Logger.log(tab + ": " + rows.length + "行を書き出しました");
}

// ------------------------------------------------------------
// 期間
// ------------------------------------------------------------

// スクリプトのサーバ時刻はUTCのため、年月日の判定は必ずJSTへ変換してから行う。
// Yahooのレポート指定は yyyyMMdd、シートの表示は yyyy-MM-dd を使う。
function resolveRanges() {
  var now = new Date();
  var y = Number(Utilities.formatDate(now, CONFIG.TIMEZONE, "yyyy"));
  var m = Number(Utilities.formatDate(now, CONFIG.TIMEZONE, "MM"));
  var yesterday = Utilities.formatDate(new Date(now.getTime() - 86400000), CONFIG.TIMEZONE, "yyyy-MM-dd");

  var prevY = m === 1 ? y - 1 : y;
  var prevM = m === 1 ? 12 : m - 1;
  var prevStart = prevY + "-" + pad2(prevM) + "-01";
  var curStart = y + "-" + pad2(m) + "-01";

  return {
    prev: { label: "前月", start: prevStart, end: lastDayOf(prevY, prevM), empty: false },
    cur: { label: "当月", start: curStart, end: yesterday, empty: yesterday < curStart }
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

function compact(dateStr) {
  return dateStr.replace(/-/g, "");
}

// ------------------------------------------------------------
// 取得
// ------------------------------------------------------------

function buildFields(matchTypeField) {
  return [
    "SEARCH_QUERY", matchTypeField, "CAMPAIGN_NAME", "ADGROUP_NAME",
    "KEYWORD_ID", "KEYWORD", "IMPS", "CLICKS", "COST", "CONVERSIONS"
  ];
}

function fetchQueries(start, end) {
  var candidates;
  if (RESOLVED_MATCH_FIELD) candidates = [RESOLVED_MATCH_FIELD];
  else if (CONFIG.MATCH_TYPE_FIELD) candidates = [CONFIG.MATCH_TYPE_FIELD];
  else candidates = MATCH_TYPE_FIELD_CANDIDATES;

  for (var i = 0; i < candidates.length; i++) {
    var fields = buildFields(candidates[i]);
    var raw;
    try {
      raw = AdsUtilities.getSearchReport({
        accountId: AdsUtilities.getCurrentAccountId(),
        reportType: CONFIG.REPORT_TYPE,
        fields: fields,
        reportDateRangeType: "CUSTOM_DATE",
        dateRange: { startDate: compact(start), endDate: compact(end) },
        reportSkipColumnHeader: "TRUE",
        reportSkipReportSummary: "TRUE"
      });
    } catch (e) {
      Logger.log("  フィールド " + candidates[i] + " では取得できません: " + e);
      continue;
    }
    // 項目名が不正でも例外ではなく空レポートで返ることがある。0行で確定させると
    // 残りの候補を試さずに終わり、名前の誤りをデータ無しと読み違える。
    if (!raw || !raw.reports || !raw.reports[0] ||
        !raw.reports[0].rows || raw.reports[0].rows.length === 0) {
      Logger.log("  フィールド " + candidates[i] + " ではレポートが空でした");
      continue;
    }
    if (RESOLVED_MATCH_FIELD !== candidates[i]) {
      Logger.log("  マッチタイプ列は " + candidates[i] + " で取得しました");
      RESOLVED_MATCH_FIELD = candidates[i];
    }
    return aggregate(parseReport(raw, fields), candidates[i]);
  }

  // 差し替えているのはマッチタイプ列だけだが、KEYWORD_ID・KEYWORD・COST 等の
  // 項目名が違っても全候補が同じ理由で落ちる。切り分けは上のエラーログを見る。
  Logger.log("★ 全候補でレポートを取得できませんでした。項目名の誤りか、対象期間にデータが無いかを" +
             "直前のエラーログで切り分け、判明した項目名を CONFIG.MATCH_TYPE_FIELD に入れてください");
  return [];
}

function parseReport(raw, fields) {
  var rows = raw.reports[0].rows || [];
  return rows.map(function (r) {
    if (Array.isArray(r)) {
      var obj = {};
      fields.forEach(function (f, i) { obj[f] = r[i] != null ? r[i] : ""; });
      return obj;
    }
    return r;
  });
}

function aggregate(rows, matchTypeField) {
  var map = {};
  var seen = 0;

  rows.forEach(function (r) {
    seen++;
    var q = String(r.SEARCH_QUERY || "");
    // 総計行はクエリが空で返る。reportSkipReportSummary を付けていても
    // 空行が混ざることがあるため、ここでも落とす。
    if (!q) return;

    var match = matchTypeLabel(r[matchTypeField]);
    var cp = String(r.CAMPAIGN_NAME || "");
    var ag = String(r.ADGROUP_NAME || "");
    var kwId = String(r.KEYWORD_ID || "");
    var kwText = String(r.KEYWORD || "");

    var key = JSON.stringify([q, match, cp, ag, kwId]);
    if (!map[key]) {
      map[key] = { q: q, match: match, cp: cp, ag: ag, kwId: kwId, kwText: kwText,
                   imp: 0, clicks: 0, cost: 0, conv: 0 };
    }
    var a = map[key];
    a.imp += toNum(r.IMPS);
    a.clicks += toNum(r.CLICKS);
    a.cost += toNum(r.COST);
    a.conv += toNum(r.CONVERSIONS);
  });

  var out = Object.keys(map).map(function (k) { return map[k]; });
  // CV降順 → COST降順。
  out.sort(function (a, b) {
    return (b.conv - a.conv) || (b.cost - a.cost) || (b.imp - a.imp);
  });

  Logger.log("  取得: 生" + seen + "行 → 合算後" + out.length + "行");
  return out;
}

// レポートの数値は桁区切りや通貨記号が付いた文字列で返ることがある。
// そのまま加算すると文字列連結になり、集計が静かに壊れる。
// 符号は先頭のみ有効とする。途中のハイフンを残すと "1-2" が 1 として通る。
function toNum(v) {
  if (typeof v === "number") return v;
  var s = String(v == null ? "" : v).trim();
  var sign = s.charAt(0) === "-" ? -1 : 1;
  var n = parseFloat(s.replace(/[^0-9.]/g, ""));
  return isNaN(n) ? 0 : n * sign;
}

// LINEヤフー広告の公式表記は「部分一致」である。Google広告の「インテントマッチ」を
// こちらへ転用すると、媒体の公式名称でない語がそのまま社内資料へ流れる。
function matchTypeLabel(v) {
  var m = {
    EXACT: "完全一致",
    PHRASE: "フレーズ一致",
    BROAD: "部分一致"
  };
  var k = String(v || "").toUpperCase();
  return m[k] || String(v || "");
}

// ------------------------------------------------------------
// 書き出し
// ------------------------------------------------------------

function writeSheet(tab, rows, range) {
  var sheet = getOrCreate(tab);
  sheet.clear();
  fitGrid(sheet, HEADER.length, rows.length + 10);

  sheet.getRange(1, 1, 1, 1).setValues([[noteLine(range)]]);
  sheet.getRange(2, 1, 1, HEADER.length).setValues([HEADER]);

  // クエリ・キーワードID・キーワードは書き込み前にテキスト書式にする。
  // 数字だけのクエリやIDが数値へ変換され、桁落ちや指数表記になるのを防ぐ。
  applyTextColumns(sheet, rows.length);

  var fee = CONFIG.FEE;
  var values = rows.map(function (a) {
    var cost = a.cost * fee;
    return [
      a.q, a.match, a.cp, a.ag, a.kwId, a.kwText,
      a.imp, a.clicks,
      a.imp ? a.clicks / a.imp : 0,
      a.clicks ? cost / a.clicks : 0,
      cost, a.conv,
      a.clicks ? a.conv / a.clicks : 0,
      a.conv ? cost / a.conv : 0
    ];
  });

  // clear済みのタブへ分割して書くため、途中で落ちるとその日のデータが欠けた状態で残る。
  // 黙って欠けると気づけないので、ログに残したうえで実行を失敗として終わらせる。
  try {
    for (var i = 0; i < values.length; i += CONFIG.WRITE_CHUNK) {
      var chunk = values.slice(i, i + CONFIG.WRITE_CHUNK);
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
  var sheet = getOrCreate(tab);
  sheet.clear();
  fitGrid(sheet, HEADER.length, 10);
  sheet.getRange(1, 1, 1, 1).setValues([[noteLine(range)]]);
  sheet.getRange(2, 1, 1, HEADER.length).setValues([HEADER]);
  applyFormat(sheet, 0);
}

function noteLine(range) {
  var period = range.empty
    ? range.label + " 対象日なし（前日は前月末日のため前月タブを参照）"
    : "集計期間 " + range.start + " 〜 " + range.end + "（" + range.label + "）";
  return period + "／fee係数 " + CONFIG.FEE +
         (CONFIG.FEE === 1 ? "（管理画面ベース）" : "（請求ベース）") +
         "／検索広告（YSA）のみ／出力 " +
         Utilities.formatDate(new Date(), CONFIG.TIMEZONE, "yyyy-MM-dd HH:mm");
}

function getOrCreate(tab) {
  var ss = SpreadsheetApp.openById(CONFIG.SHEET_ID);
  var sheet = ss.getSheetByName(tab);
  if (!sheet) {
    sheet = ss.insertSheet(tab);
    Logger.log("タブ新規作成: " + tab);
  }
  return sheet;
}

function applyTextColumns(sheet, n) {
  if (n === 0) return;
  try { sheet.getRange(3, 1, n, 1).setNumberFormat("@"); } catch (e) { Logger.log("書式スキップ クエリ列: " + e); }
  try { sheet.getRange(3, 5, n, 2).setNumberFormat("@"); } catch (e) { Logger.log("書式スキップ KW列: " + e); }
}

function applyFormat(sheet, n) {
  var head = sheet.getRange(2, 1, 1, HEADER.length);
  try { head.setFontWeight("bold"); } catch (e) { Logger.log("書式スキップ setFontWeight: " + e); }
  try { head.setBackground("#262626"); } catch (e) { Logger.log("書式スキップ setBackground: " + e); }
  try { head.setFontColor("#ffffff"); } catch (e) { Logger.log("書式スキップ setFontColor: " + e); }
  try { sheet.setFrozenRows(2); } catch (e) { Logger.log("書式スキップ setFrozenRows: " + e); }
  try { sheet.setFrozenColumns(2); } catch (e) { Logger.log("書式スキップ setFrozenColumns: " + e); }

  try {
    sheet.setColumnWidth(1, 260);
    sheet.setColumnWidth(2, 110);
    sheet.setColumnWidth(3, 190);
    sheet.setColumnWidth(4, 150);
    sheet.setColumnWidth(6, 200);
  } catch (e) { Logger.log("書式スキップ 列幅: " + e); }

  if (n === 0) return;

  try {
    sheet.getRange(3, 7, n, 2).setNumberFormat("#,##0");      // 表示回数・クリック
    sheet.getRange(3, 9, n, 1).setNumberFormat("0.00%");      // CTR
    sheet.getRange(3, 10, n, 2).setNumberFormat("¥#,##0");    // CPC・COST
    sheet.getRange(3, 12, n, 1).setNumberFormat("#,##0.00");  // CV
    sheet.getRange(3, 13, n, 1).setNumberFormat("0.00%");     // CVR
    sheet.getRange(3, 14, n, 1).setNumberFormat("¥#,##0");    // CPA
  } catch (e) { Logger.log("書式スキップ 数値書式: " + e); }

  try {
    sheet.getRange(2, 1, n + 1, HEADER.length)
      .setBorder(true, true, true, true, true, true, "#bfbfbf", SpreadsheetApp.BorderStyle.SOLID);
  } catch (e) { Logger.log("書式スキップ 罫線: " + e); }
}

// グリッドを必要な寸法へ合わせる。増やすだけにすると、行数がピークだった日の寸法が
// 恒久的に残り、同じブックに同居する他タブと合わせて1ブック1,000万セルの上限に効く。
function fitGrid(sheet, needCols, needRows) {
  var addCols = needCols - sheet.getMaxColumns();
  if (addCols > 0) sheet.insertColumnsAfter(sheet.getMaxColumns(), addCols);

  var keep = Math.max(needRows, 1);
  var diff = keep - sheet.getMaxRows();
  if (diff > 0) {
    sheet.insertRowsAfter(sheet.getMaxRows(), diff);
  } else if (diff < 0) {
    // 縮小は余剰行の掃除にすぎない。この実行環境で deleteRows が使えなくても
    // 出力そのものは成立するため、落ちてもログに残して書き込みへ進む。
    try {
      sheet.deleteRows(keep + 1, -diff);
    } catch (e) {
      Logger.log("グリッド縮小スキップ deleteRows: " + e);
    }
  }
}
