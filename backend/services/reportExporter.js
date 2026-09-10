/**
 * Bazar (SalesTrack) — Report Exporter Service
 * Generates high-resolution PNG images via @napi-rs/canvas
 * and executive Excel (.xlsx) workbooks via ExcelJS.
 * 
 * STRICT ARCHITECTURAL RULE:
 * Exporters are pure rendering functions. They NEVER query the database.
 * They consume the normalized reportData structure produced by reportService.
 */

const ExcelJS = require('exceljs');
const { createCanvas } = require('@napi-rs/canvas');

/**
 * Format currency number to space-separated string: 1400000 -> "1 400 000"
 */
function formatNum(n) {
  if (n === null || n === undefined || isNaN(n)) return '0';
  return Math.round(Number(n)).toLocaleString('ru-RU').replace(/,/g, ' ');
}

// ============================================================================
// 1. SINGLE-DAY EXCEL EXPORT (.xlsx)
// ============================================================================
async function generateExcelReport(reportData) {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'Bazar';
  wb.lastModifiedBy = 'Bazar Telegram Bot';
  wb.created = new Date();
  wb.modified = new Date();

  const ws = wb.addWorksheet('Kunlik hisobot', {
    views: [{ showGridLines: true, state: 'frozen', ySplit: 7 }],
    pageSetup: { orientation: 'landscape', fitToWidth: 1, fitToHeight: 0 }
  });

  ws.columns = [
    { key: 'col1', width: 8 },
    { key: 'col2', width: 38 },
    { key: 'col3', width: 14 },
    { key: 'col4', width: 20 },
    { key: 'col5', width: 22 }
  ];

  // 1. Title Banner
  ws.mergeCells('A1:E1');
  const titleCell = ws.getCell('A1');
  titleCell.value = 'BAZAR — KUNLIK SAVDO HISOBOTI';
  titleCell.font = { name: 'Segoe UI', size: 16, bold: true, color: { argb: 'FFFFFFFF' } };
  titleCell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1E293B' } };
  titleCell.alignment = { vertical: 'middle', horizontal: 'center' };
  ws.getRow(1).height = 36;

  // 2. Date Banner
  ws.mergeCells('A2:E2');
  const dateCell = ws.getCell('A2');
  dateCell.value = `HISOBOT SANASI: ${reportData.date}`;
  dateCell.font = { name: 'Segoe UI', size: 12, bold: true, color: { argb: 'FFFFFFFF' } };
  dateCell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF0F172A' } };
  dateCell.alignment = { vertical: 'middle', horizontal: 'center' };
  ws.getRow(2).height = 28;

  // 3. Metadata
  ws.mergeCells('A3:E3');
  const metaCell = ws.getCell('A3');
  metaCell.value = `Valyuta: UZS (soʻm)   |   Vaqt mintaqasi: Asia/Tashkent (UTC+05:00)`;
  metaCell.font = { name: 'Segoe UI', size: 9, italic: true, color: { argb: 'FF64748B' } };
  metaCell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF1F5F9' } };
  metaCell.alignment = { vertical: 'middle', horizontal: 'center' };
  ws.getRow(3).height = 20;

  // 4. KPI Summary Row
  ws.getRow(4).height = 10; // gap

  ws.getCell('A5').value = 'JAMI TUSHUM';
  ws.getCell('B5').value = 'JAMI SOTILDI';
  ws.getCell('C5').value = 'CHEGIRMA';
  ws.getCell('D5').value = 'CHIQIM';
  ws.getCell('E5').value = 'SOF KASSA';

  const kpiRow = ws.getRow(5);
  kpiRow.font = { name: 'Segoe UI', size: 10, bold: true, color: { argb: 'FF475569' } };
  kpiRow.alignment = { horizontal: 'center', vertical: 'middle' };

  ws.getCell('A6').value = `${formatNum(reportData.totals.netSales)} so'm`;
  ws.getCell('B6').value = `${reportData.totals.itemsSold} dona (${reportData.totals.transactionCount} ta savdo)`;
  ws.getCell('C6').value = `${formatNum(reportData.totals.discount)} so'm`;
  ws.getCell('D6').value = `−${formatNum(reportData.totals.chiqim)} so'm`;
  ws.getCell('E6').value = `${formatNum(reportData.totals.netCash)} so'm`;

  const valRow = ws.getRow(6);
  valRow.height = 28;
  valRow.font = { name: 'Segoe UI', size: 12, bold: true };
  valRow.alignment = { horizontal: 'center', vertical: 'middle' };

  ws.getCell('A6').font = { name: 'Segoe UI', size: 13, bold: true, color: { argb: 'FF16A34A' } };
  ws.getCell('D6').font = { name: 'Segoe UI', size: 12, bold: true, color: { argb: 'FFDC2626' } };
  ws.getCell('E6').font = { name: 'Segoe UI', size: 13, bold: true, color: { argb: 'FF0284C7' } };

  let currRow = 8;

  // 5. Chiqim Section (if any)
  if (reportData.cashOuts && reportData.cashOuts.length > 0) {
    ws.mergeCells(`A${currRow}:E${currRow}`);
    const chiqimTitle = ws.getCell(`A${currRow}`);
    chiqimTitle.value = '💸 KASSADAN CHIQIMLAR';
    chiqimTitle.font = { name: 'Segoe UI', size: 11, bold: true, color: { argb: 'FFDC2626' } };
    chiqimTitle.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFEE2E2' } };
    ws.getRow(currRow).height = 24;
    currRow++;

    ws.getCell(`A${currRow}`).value = '#';
    ws.getCell(`B${currRow}`).value = 'Sabab / Izoh';
    ws.getCell(`C${currRow}`).value = 'Vaqt';
    ws.getCell(`D${currRow}`).value = '';
    ws.getCell(`E${currRow}`).value = 'Miqdor';

    const chiqimHead = ws.getRow(currRow);
    chiqimHead.font = { name: 'Segoe UI', size: 10, bold: true, color: { argb: 'FFFFFFFF' } };
    chiqimHead.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF991B1B' } };
    currRow++;

    reportData.cashOuts.forEach((c, idx) => {
      ws.getCell(`A${currRow}`).value = idx + 1;
      ws.getCell(`B${currRow}`).value = c.reason || 'Kassadan chiqim';
      ws.getCell(`C${currRow}`).value = c.timeFormatted || '';
      ws.getCell(`E${currRow}`).value = `−${formatNum(c.amount)} so'm`;
      ws.getCell(`E${currRow}`).font = { bold: true, color: { argb: 'FFDC2626' } };
      ws.getCell(`E${currRow}`).alignment = { horizontal: 'right' };
      currRow++;
    });

    currRow += 2;
  }

  // 6. Items Sold Section
  ws.mergeCells(`A${currRow}:E${currRow}`);
  const itemsTitle = ws.getCell(`A${currRow}`);
  itemsTitle.value = '📦 SOTILGAN MAHSULOTLAR';
  itemsTitle.font = { name: 'Segoe UI', size: 11, bold: true, color: { argb: 'FFFFFFFF' } };
  itemsTitle.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF334155' } };
  ws.getRow(currRow).height = 24;
  currRow++;

  ws.getCell(`A${currRow}`).value = '#';
  ws.getCell(`B${currRow}`).value = 'Mahsulot nomi';
  ws.getCell(`C${currRow}`).value = 'Soni';
  ws.getCell(`D${currRow}`).value = 'Dona narxi';
  ws.getCell(`E${currRow}`).value = 'Jami summa';

  const itemsHead = ws.getRow(currRow);
  itemsHead.font = { name: 'Segoe UI', size: 10, bold: true, color: { argb: 'FFFFFFFF' } };
  itemsHead.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1E293B' } };
  currRow++;

  if (!reportData.items || reportData.items.length === 0) {
    ws.mergeCells(`A${currRow}:E${currRow}`);
    ws.getCell(`A${currRow}`).value = "Bu kunda sotuvlar qayd etilmagan";
    ws.getCell(`A${currRow}`).alignment = { horizontal: 'center' };
    currRow++;
  } else {
    reportData.items.forEach((item, idx) => {
      const row = ws.getRow(currRow);
      ws.getCell(`A${currRow}`).value = idx + 1;
      ws.getCell(`A${currRow}`).alignment = { horizontal: 'center' };

      ws.getCell(`B${currRow}`).value = item.name;
      ws.getCell(`C${currRow}`).value = item.quantity;
      ws.getCell(`C${currRow}`).alignment = { horizontal: 'center' };

      ws.getCell(`D${currRow}`).value = `${formatNum(item.unitPrice)} so'm`;
      ws.getCell(`D${currRow}`).alignment = { horizontal: 'right' };

      ws.getCell(`E${currRow}`).value = `${formatNum(item.total)} so'm`;
      ws.getCell(`E${currRow}`).font = { bold: true };
      ws.getCell(`E${currRow}`).alignment = { horizontal: 'right' };

      if (idx % 2 === 1) {
        row.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF8FAFC' } };
      }
      currRow++;
    });

    // Total Row
    ws.mergeCells(`A${currRow}:B${currRow}`);
    ws.getCell(`A${currRow}`).value = 'JAMI';
    ws.getCell(`A${currRow}`).alignment = { horizontal: 'right' };
    ws.getCell(`A${currRow}`).font = { bold: true };

    ws.getCell(`C${currRow}`).value = reportData.totals.itemsSold;
    ws.getCell(`C${currRow}`).font = { bold: true };
    ws.getCell(`C${currRow}`).alignment = { horizontal: 'center' };

    ws.getCell(`E${currRow}`).value = `${formatNum(reportData.totals.grossSales)} so'm`;
    ws.getCell(`E${currRow}`).font = { bold: true, color: { argb: 'FF16A34A' } };
    ws.getCell(`E${currRow}`).alignment = { horizontal: 'right' };
    ws.getRow(currRow).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF1F5F9' } };
  }

  const buffer = await wb.xlsx.writeBuffer();
  return Buffer.from(buffer);
}

// ============================================================================
// 2. 7-DAY EXCEL EXPORT (.xlsx)
// ============================================================================
async function generate7DayExcelReport(sevenDayData) {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'Bazar';
  wb.lastModifiedBy = 'Bazar Telegram Bot';

  const ws = wb.addWorksheet('7 kunlik hisobot', {
    views: [{ showGridLines: true, state: 'frozen', ySplit: 6 }],
    pageSetup: { orientation: 'landscape', fitToWidth: 1, fitToHeight: 0 }
  });

  ws.columns = [
    { key: 'date', width: 14 },
    { key: 'gross', width: 20 },
    { key: 'discount', width: 16 },
    { key: 'net', width: 22 },
    { key: 'items', width: 14 },
    { key: 'chiqim', width: 18 },
    { key: 'netCash', width: 22 }
  ];

  // Title
  ws.mergeCells('A1:G1');
  const title = ws.getCell('A1');
  title.value = 'BAZAR — 7 KUNLIK SAVDO TAHLILI';
  title.font = { name: 'Segoe UI', size: 16, bold: true, color: { argb: 'FFFFFFFF' } };
  title.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1E293B' } };
  title.alignment = { vertical: 'middle', horizontal: 'center' };
  ws.getRow(1).height = 36;

  // Range
  ws.mergeCells('A2:G2');
  const range = ws.getCell('A2');
  range.value = `DAVR: ${sevenDayData.startDate} dan ${sevenDayData.endDate} gacha`;
  range.font = { name: 'Segoe UI', size: 12, bold: true, color: { argb: 'FFFFFFFF' } };
  range.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF0F172A' } };
  range.alignment = { vertical: 'middle', horizontal: 'center' };
  ws.getRow(2).height = 28;

  // Metadata
  ws.mergeCells('A3:G3');
  const meta = ws.getCell('A3');
  meta.value = 'Valyuta: UZS (soʻm)   |   Asia/Tashkent (UTC+05:00)';
  meta.font = { name: 'Segoe UI', size: 9, italic: true, color: { argb: 'FF64748B' } };
  meta.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF1F5F9' } };
  meta.alignment = { vertical: 'middle', horizontal: 'center' };

  ws.getRow(4).height = 12; // gap

  // Table Headers
  ws.getCell('A5').value = 'Sana';
  ws.getCell('B5').value = 'Savdo (Gross)';
  ws.getCell('C5').value = 'Chegirma';
  ws.getCell('D5').value = 'Sof Savdo (Net)';
  ws.getCell('E5').value = 'Sotildi';
  ws.getCell('F5').value = 'Chiqim';
  ws.getCell('G5').value = 'Sof Kassa';

  const head = ws.getRow(5);
  head.height = 26;
  head.font = { name: 'Segoe UI', size: 10, bold: true, color: { argb: 'FFFFFFFF' } };
  head.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1E293B' } };
  head.alignment = { vertical: 'middle', horizontal: 'center' };

  let rIdx = 6;
  sevenDayData.dailyReports.forEach((d, idx) => {
    const row = ws.getRow(rIdx);
    ws.getCell(`A${rIdx}`).value = d.displayDate || d.date;
    ws.getCell(`A${rIdx}`).alignment = { horizontal: 'center' };

    ws.getCell(`B${rIdx}`).value = `${formatNum(d.totals.grossSales)} so'm`;
    ws.getCell(`B${rIdx}`).alignment = { horizontal: 'right' };

    ws.getCell(`C${rIdx}`).value = `${formatNum(d.totals.discount)} so'm`;
    ws.getCell(`C${rIdx}`).alignment = { horizontal: 'right' };

    ws.getCell(`D${rIdx}`).value = `${formatNum(d.totals.netSales)} so'm`;
    ws.getCell(`D${rIdx}`).font = { bold: true };
    ws.getCell(`D${rIdx}`).alignment = { horizontal: 'right' };

    ws.getCell(`E${rIdx}`).value = `${d.totals.itemsSold} dona`;
    ws.getCell(`E${rIdx}`).alignment = { horizontal: 'center' };

    ws.getCell(`F${rIdx}`).value = d.totals.chiqim > 0 ? `−${formatNum(d.totals.chiqim)} so'm` : '0';
    ws.getCell(`F${rIdx}`).font = { color: { argb: d.totals.chiqim > 0 ? 'FFDC2626' : 'FF64748B' } };
    ws.getCell(`F${rIdx}`).alignment = { horizontal: 'right' };

    ws.getCell(`G${rIdx}`).value = `${formatNum(d.totals.netCash)} so'm`;
    ws.getCell(`G${rIdx}`).font = { bold: true, color: { argb: 'FF0284C7' } };
    ws.getCell(`G${rIdx}`).alignment = { horizontal: 'right' };

    if (idx % 2 === 1) {
      row.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF8FAFC' } };
    }
    rIdx++;
  });

  // Rollup Row
  ws.getCell(`A${rIdx}`).value = 'JAMI (7 KUN)';
  ws.getCell(`A${rIdx}`).font = { bold: true };
  ws.getCell(`A${rIdx}`).alignment = { horizontal: 'center' };

  ws.getCell(`B${rIdx}`).value = `${formatNum(sevenDayData.rollup.grossSales)} so'm`;
  ws.getCell(`B${rIdx}`).font = { bold: true };
  ws.getCell(`B${rIdx}`).alignment = { horizontal: 'right' };

  ws.getCell(`C${rIdx}`).value = `${formatNum(sevenDayData.rollup.discount)} so'm`;
  ws.getCell(`C${rIdx}`).font = { bold: true };
  ws.getCell(`C${rIdx}`).alignment = { horizontal: 'right' };

  ws.getCell(`D${rIdx}`).value = `${formatNum(sevenDayData.rollup.netSales)} so'm`;
  ws.getCell(`D${rIdx}`).font = { bold: true, color: { argb: 'FF16A34A' } };
  ws.getCell(`D${rIdx}`).alignment = { horizontal: 'right' };

  ws.getCell(`E${rIdx}`).value = `${sevenDayData.rollup.itemsSold} dona`;
  ws.getCell(`E${rIdx}`).font = { bold: true };
  ws.getCell(`E${rIdx}`).alignment = { horizontal: 'center' };

  ws.getCell(`F${rIdx}`).value = `−${formatNum(sevenDayData.rollup.chiqim)} so'm`;
  ws.getCell(`F${rIdx}`).font = { bold: true, color: { argb: 'FFDC2626' } };
  ws.getCell(`F${rIdx}`).alignment = { horizontal: 'right' };

  ws.getCell(`G${rIdx}`).value = `${formatNum(sevenDayData.rollup.netCash)} so'm`;
  ws.getCell(`G${rIdx}`).font = { bold: true, color: { argb: 'FF0284C7' } };
  ws.getCell(`G${rIdx}`).alignment = { horizontal: 'right' };

  ws.getRow(rIdx).height = 28;
  ws.getRow(rIdx).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE2E8F0' } };

  const buffer = await wb.xlsx.writeBuffer();
  return Buffer.from(buffer);
}

// ============================================================================
// 3. SINGLE-DAY PNG EXPORT (860px Canvas)
// ============================================================================
async function generatePngReport(reportData) {
  const width = 860;
  const padding = 28;

  // Calculate dynamic canvas height
  const itemsCount = reportData.items ? reportData.items.length : 0;
  const cashOutCount = reportData.cashOuts ? reportData.cashOuts.length : 0;

  let height = 340; // Base: Header (100px) + KPI Grid (150px) + padding
  if (cashOutCount > 0) {
    height += 60 + (cashOutCount * 36) + 16;
  }
  if (itemsCount > 0) {
    height += 60 + (Math.min(itemsCount, 25) * 36) + 50; // max 25 displayed items in image
  } else {
    height += 80;
  }

  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext('2d');

  // Background
  ctx.fillStyle = '#0A0D14';
  ctx.fillRect(0, 0, width, height);

  // Card Container
  ctx.fillStyle = '#141A26';
  ctx.strokeStyle = '#232D3F';
  ctx.lineWidth = 1.5;
  roundRect(ctx, padding, padding, width - padding * 2, height - padding * 2, 16);
  ctx.fill();
  ctx.stroke();

  let y = padding + 24;

  // Header: Logo / Brand
  ctx.fillStyle = '#D4AF37'; // Gold
  ctx.font = 'bold 24px sans-serif';
  ctx.fillText('BAZAR', padding + 24, y + 20);

  ctx.fillStyle = '#94A3B8';
  ctx.font = '13px sans-serif';
  ctx.fillText('Kunlik savdo va kassa hisoboti', padding + 24, y + 42);

  // Header: Date Badge
  const dateBadgeText = `📅 ${reportData.date}`;
  ctx.font = 'bold 14px sans-serif';
  const badgeWidth = ctx.measureText(dateBadgeText).width + 24;
  const badgeX = width - padding - 24 - badgeWidth;

  ctx.fillStyle = '#1E293B';
  roundRect(ctx, badgeX, y, badgeWidth, 34, 17);
  ctx.fill();

  ctx.fillStyle = '#F8FAFC';
  ctx.fillText(dateBadgeText, badgeX + 12, y + 22);

  y += 66;

  // Divider
  ctx.strokeStyle = '#232D3F';
  ctx.beginPath();
  ctx.moveTo(padding + 24, y);
  ctx.lineTo(width - padding - 24, y);
  ctx.stroke();

  y += 20;

  // 4 KPI Cards
  const kpiWidth = (width - padding * 2 - 48 - (3 * 12)) / 4;
  const kpiHeight = 90;

  const kpis = [
    {
      title: 'JAMI TUSHUM',
      value: `${formatNum(reportData.totals.netSales)} so'm`,
      sub: `${reportData.totals.transactionCount} ta savdo`,
      bg: 'rgba(22, 163, 74, 0.12)',
      border: 'rgba(34, 197, 94, 0.35)',
      valColor: '#22C55E'
    },
    {
      title: 'JAMI SOTILDI',
      value: `${reportData.totals.itemsSold} dona`,
      sub: reportData.totals.discount > 0 ? `Chegirma: −${formatNum(reportData.totals.discount)}` : 'Mahsulotlar soni',
      bg: '#1A2333',
      border: '#2A374A',
      valColor: '#F8FAFC'
    },
    {
      title: 'KASSADAN CHIQIM',
      value: `−${formatNum(reportData.totals.chiqim)} so'm`,
      sub: `${cashOutCount} ta chiqim`,
      bg: 'rgba(239, 68, 68, 0.12)',
      border: 'rgba(239, 68, 68, 0.35)',
      valColor: '#EF4444'
    },
    {
      title: 'SOF KASSA',
      value: `${formatNum(reportData.totals.netCash)} so'm`,
      sub: 'Kassadagi naqd pul',
      bg: 'rgba(2, 132, 199, 0.12)',
      border: 'rgba(2, 132, 199, 0.35)',
      valColor: '#38BDF8'
    }
  ];

  kpis.forEach((kpi, idx) => {
    const kpiX = padding + 24 + idx * (kpiWidth + 12);
    ctx.fillStyle = kpi.bg;
    ctx.strokeStyle = kpi.border;
    ctx.lineWidth = 1;
    roundRect(ctx, kpiX, y, kpiWidth, kpiHeight, 10);
    ctx.fill();
    ctx.stroke();

    ctx.fillStyle = '#94A3B8';
    ctx.font = 'bold 10px sans-serif';
    ctx.fillText(kpi.title, kpiX + 12, y + 20);

    ctx.fillStyle = kpi.valColor;
    ctx.font = 'bold 16px sans-serif';
    ctx.fillText(kpi.value, kpiX + 12, y + 48);

    ctx.fillStyle = '#64748B';
    ctx.font = '11px sans-serif';
    ctx.fillText(kpi.sub, kpiX + 12, y + 72);
  });

  y += kpiHeight + 24;

  // Chiqim Section
  if (cashOutCount > 0) {
    ctx.fillStyle = '#EF4444';
    ctx.font = 'bold 12px sans-serif';
    ctx.fillText('💸 KASSADAN CHIQIMLAR', padding + 24, y);
    y += 12;

    reportData.cashOuts.forEach((c, idx) => {
      const rowY = y + (idx * 32);
      ctx.fillStyle = idx % 2 === 0 ? '#182030' : '#141A26';
      ctx.fillRect(padding + 24, rowY, width - padding * 2 - 48, 28);

      ctx.fillStyle = '#94A3B8';
      ctx.font = '11px sans-serif';
      ctx.fillText(c.timeFormatted || '', padding + 34, rowY + 18);

      ctx.fillStyle = '#F8FAFC';
      ctx.font = 'bold 12px sans-serif';
      ctx.fillText(c.reason, padding + 90, rowY + 18);

      ctx.fillStyle = '#DC2626';
      ctx.font = 'bold 12px sans-serif';
      const amtStr = `−${formatNum(c.amount)} so'm`;
      const amtW = ctx.measureText(amtStr).width;
      ctx.fillText(amtStr, width - padding - 36 - amtW, rowY + 18);
    });

    y += (cashOutCount * 32) + 20;
  }

  // Items Section
  ctx.fillStyle = '#F8FAFC';
  ctx.font = 'bold 13px sans-serif';
  ctx.fillText('📦 SOTILGAN MAHSULOTLAR', padding + 24, y);
  y += 16;

  // Items Table Header
  const tableX = padding + 24;
  const tableW = width - padding * 2 - 48;

  ctx.fillStyle = '#1E293B';
  ctx.fillRect(tableX, y, tableW, 28);

  ctx.fillStyle = '#94A3B8';
  ctx.font = 'bold 11px sans-serif';
  ctx.fillText('#', tableX + 10, y + 18);
  ctx.fillText('Mahsulot nomi', tableX + 40, y + 18);
  ctx.fillText('Soni', tableX + tableW - 240, y + 18);
  ctx.fillText('Narxi', tableX + tableW - 160, y + 18);
  ctx.fillText('Jami', tableX + tableW - 70, y + 18);

  y += 28;

  if (itemsCount === 0) {
    ctx.fillStyle = '#64748B';
    ctx.font = 'italic 12px sans-serif';
    ctx.fillText("Bu kunda sotuvlar qayd etilmagan", tableX + 20, y + 24);
  } else {
    const displayItems = reportData.items.slice(0, 25);
    displayItems.forEach((it, idx) => {
      ctx.fillStyle = idx % 2 === 1 ? '#182030' : '#141A26';
      ctx.fillRect(tableX, y, tableW, 30);

      ctx.fillStyle = '#64748B';
      ctx.font = '11px sans-serif';
      ctx.fillText(String(idx + 1), tableX + 10, y + 20);

      ctx.fillStyle = '#F8FAFC';
      ctx.font = 'bold 12px sans-serif';
      const name = it.name.length > 34 ? it.name.substring(0, 32) + '…' : it.name;
      ctx.fillText(name, tableX + 40, y + 20);

      ctx.fillStyle = '#E2E8F0';
      ctx.font = '12px sans-serif';
      ctx.fillText(`${it.quantity} dona`, tableX + tableW - 240, y + 20);
      ctx.fillText(`${formatNum(it.unitPrice)}`, tableX + tableW - 160, y + 20);

      ctx.fillStyle = '#22C55E';
      ctx.font = 'bold 12px sans-serif';
      ctx.fillText(`${formatNum(it.total)}`, tableX + tableW - 70, y + 20);

      y += 30;
    });

    if (itemsCount > 25) {
      ctx.fillStyle = '#64748B';
      ctx.font = 'italic 11px sans-serif';
      ctx.fillText(`... va yana ${itemsCount - 25} ta mahsulot (to'liq ro'yxat Excel faylida)`, tableX + 10, y + 20);
    }
  }

  return canvas.toBuffer('image/png');
}

// ============================================================================
// 4. 7-DAY PNG EXPORT (860px Canvas)
// ============================================================================
async function generate7DayPngReport(sevenDayData) {
  const width = 860;
  const padding = 28;
  const rowHeight = 34;
  const height = 300 + (sevenDayData.dailyReports.length * rowHeight) + 80;

  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext('2d');

  // Background
  ctx.fillStyle = '#0A0D14';
  ctx.fillRect(0, 0, width, height);

  // Card Container
  ctx.fillStyle = '#141A26';
  ctx.strokeStyle = '#232D3F';
  ctx.lineWidth = 1.5;
  roundRect(ctx, padding, padding, width - padding * 2, height - padding * 2, 16);
  ctx.fill();
  ctx.stroke();

  let y = padding + 24;

  // Header
  ctx.fillStyle = '#D4AF37';
  ctx.font = 'bold 24px sans-serif';
  ctx.fillText('BAZAR', padding + 24, y + 20);

  ctx.fillStyle = '#94A3B8';
  ctx.font = '13px sans-serif';
  ctx.fillText('7 kunlik savdo tahlili', padding + 24, y + 42);

  // Range Badge
  const rangeText = `📅 ${sevenDayData.startDate} — ${sevenDayData.endDate}`;
  ctx.font = 'bold 13px sans-serif';
  const bWidth = ctx.measureText(rangeText).width + 24;
  const bX = width - padding - 24 - bWidth;

  ctx.fillStyle = '#1E293B';
  roundRect(ctx, bX, y, bWidth, 34, 17);
  ctx.fill();

  ctx.fillStyle = '#F8FAFC';
  ctx.fillText(rangeText, bX + 12, y + 22);

  y += 66;

  // Divider
  ctx.strokeStyle = '#232D3F';
  ctx.beginPath();
  ctx.moveTo(padding + 24, y);
  ctx.lineTo(width - padding - 24, y);
  ctx.stroke();

  y += 20;

  // 4 Rollup KPI Cards
  const kpiWidth = (width - padding * 2 - 48 - (3 * 12)) / 4;
  const kpis = [
    {
      title: '7 KUNLIK SAVDO',
      value: `${formatNum(sevenDayData.rollup.netSales)} so'm`,
      valColor: '#22C55E'
    },
    {
      title: 'JAMI SOTILDI',
      value: `${sevenDayData.rollup.itemsSold} dona`,
      valColor: '#F8FAFC'
    },
    {
      title: 'JAMI CHIQIM',
      value: `−${formatNum(sevenDayData.rollup.chiqim)} so'm`,
      valColor: '#EF4444'
    },
    {
      title: 'SOF KASSA',
      value: `${formatNum(sevenDayData.rollup.netCash)} so'm`,
      valColor: '#38BDF8'
    }
  ];

  kpis.forEach((kpi, idx) => {
    const kpiX = padding + 24 + idx * (kpiWidth + 12);
    ctx.fillStyle = '#1A2333';
    ctx.strokeStyle = '#2A374A';
    roundRect(ctx, kpiX, y, kpiWidth, 75, 10);
    ctx.fill();
    ctx.stroke();

    ctx.fillStyle = '#94A3B8';
    ctx.font = 'bold 10px sans-serif';
    ctx.fillText(kpi.title, kpiX + 12, y + 22);

    ctx.fillStyle = kpi.valColor;
    ctx.font = 'bold 16px sans-serif';
    ctx.fillText(kpi.value, kpiX + 12, y + 52);
  });

  y += 95;

  // Table
  const tableX = padding + 24;
  const tableW = width - padding * 2 - 48;

  ctx.fillStyle = '#1E293B';
  ctx.fillRect(tableX, y, tableW, 30);

  ctx.fillStyle = '#94A3B8';
  ctx.font = 'bold 11px sans-serif';
  ctx.fillText('Sana', tableX + 16, y + 20);
  ctx.fillText('Savdo (Net)', tableX + 160, y + 20);
  ctx.fillText('Sotildi', tableX + 320, y + 20);
  ctx.fillText('Chiqim', tableX + 440, y + 20);
  ctx.fillText('Sof Kassa', tableX + tableW - 130, y + 20);

  y += 30;

  sevenDayData.dailyReports.forEach((d, idx) => {
    ctx.fillStyle = idx % 2 === 1 ? '#182030' : '#141A26';
    ctx.fillRect(tableX, y, tableW, rowHeight);

    ctx.fillStyle = '#F8FAFC';
    ctx.font = 'bold 12px sans-serif';
    ctx.fillText(d.displayDate || d.date, tableX + 16, y + 22);

    ctx.fillStyle = '#22C55E';
    ctx.fillText(`${formatNum(d.totals.netSales)} so'm`, tableX + 160, y + 22);

    ctx.fillStyle = '#E2E8F0';
    ctx.font = '12px sans-serif';
    ctx.fillText(`${d.totals.itemsSold} dona`, tableX + 320, y + 22);

    ctx.fillStyle = d.totals.chiqim > 0 ? '#EF4444' : '#64748B';
    ctx.fillText(d.totals.chiqim > 0 ? `−${formatNum(d.totals.chiqim)}` : '0', tableX + 440, y + 22);

    ctx.fillStyle = '#38BDF8';
    ctx.font = 'bold 12px sans-serif';
    ctx.fillText(`${formatNum(d.totals.netCash)} so'm`, tableX + tableW - 130, y + 22);

    y += rowHeight;
  });

  // Rollup Row
  ctx.fillStyle = '#1E293B';
  ctx.fillRect(tableX, y, tableW, 36);

  ctx.fillStyle = '#D4AF37';
  ctx.font = 'bold 13px sans-serif';
  ctx.fillText('JAMI (7 KUN)', tableX + 16, y + 23);

  ctx.fillStyle = '#22C55E';
  ctx.fillText(`${formatNum(sevenDayData.rollup.netSales)} so'm`, tableX + 160, y + 23);

  ctx.fillStyle = '#F8FAFC';
  ctx.fillText(`${sevenDayData.rollup.itemsSold} dona`, tableX + 320, y + 23);

  ctx.fillStyle = '#EF4444';
  ctx.fillText(`−${formatNum(sevenDayData.rollup.chiqim)}`, tableX + 440, y + 23);

  ctx.fillStyle = '#38BDF8';
  ctx.fillText(`${formatNum(sevenDayData.rollup.netCash)} so'm`, tableX + tableW - 130, y + 23);

  return canvas.toBuffer('image/png');
}

/**
 * Helper: draw rounded rectangle
 */
function roundRect(ctx, x, y, width, height, radius) {
  ctx.beginPath();
  ctx.moveTo(x + radius, y);
  ctx.lineTo(x + width - radius, y);
  ctx.quadraticCurveTo(x + width, y, x + width, y + radius);
  ctx.lineTo(x + width, y + height - radius);
  ctx.quadraticCurveTo(x + width, y + height, x + width - radius, y + height);
  ctx.lineTo(x + radius, y + height);
  ctx.quadraticCurveTo(x, y + height, x, y + height - radius);
  ctx.lineTo(x, y + radius);
  ctx.quadraticCurveTo(x, y, x + radius, y);
  ctx.closePath();
}

module.exports = {
  generateExcelReport,
  generate7DayExcelReport,
  generatePngReport,
  generate7DayPngReport
};
