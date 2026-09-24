/**
 * Birthday Invitation — Backend (with QR tickets + admin scanner)
 */

const SHEET_RESPONSES = 'Responses';
const SHEET_WHITELIST = 'Whitelist';
const SHEET_SETTINGS  = 'Settings';
const FOLDER_NAME     = 'Birthday Selfies';

const RESPONSES_HEADERS = [
  'Timestamp', 'Name', 'Mobile', 'Address', 'Greetings',
  'Selfie URL', 'Email', 'Guests', 'Login Method',
  'Ticket Code', 'Checked In'
];

/* ============================================================
   WEB APP ENTRY
   ============================================================ */
function doGet(e) {
  const page = (e && e.parameter && e.parameter.page) || 'index';

  if (page === 'scan') {
    return HtmlService.createHtmlOutputFromFile('Scanner')
      .setTitle('Admin • Check-In Scanner')
      .addMetaTag('viewport', 'width=device-width, initial-scale=1, viewport-fit=cover')
      .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
  }

  return HtmlService.createHtmlOutputFromFile('Index')
    .setTitle('Simon Jabeguero')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1, viewport-fit=cover')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

/* ============================================================
   HELPERS
   ============================================================ */
function ss() {
  const spreadsheet = SpreadsheetApp.getActiveSpreadsheet();
  if (!spreadsheet) throw new Error('Script is not bound to a spreadsheet.');
  return spreadsheet;
}

function getSheet(name, createIfMissing) {
  const spreadsheet = ss();
  let sh = spreadsheet.getSheetByName(name);
  if (!sh && createIfMissing) sh = spreadsheet.insertSheet(name);
  return sh;
}

function getResponsesSheet() {
  const sh = getSheet(SHEET_RESPONSES, true);
  if (!sh) throw new Error('Could not create "' + SHEET_RESPONSES + '".');

  if (sh.getLastRow() === 0) {
    sh.appendRow(RESPONSES_HEADERS);
  } else {
    const headerRow = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0];
    if (headerRow.length < RESPONSES_HEADERS.length) {
      sh.getRange(1, 1, 1, RESPONSES_HEADERS.length).setValues([RESPONSES_HEADERS]);
    }
  }
  return sh;
}

function getSettings() {
  const sh = getSheet(SHEET_SETTINGS, true);
  if (!sh || sh.getLastRow() < 2) return {};
  const values = sh.getRange(1, 1, sh.getLastRow(), 2).getValues();
  const map = {};
  for (let i = 1; i < values.length; i++) {
    const key = String(values[i][0] || '').trim();
    const val = String(values[i][1] || '').trim();
    if (key) map[key] = val;
  }
  return map;
}

function getOrCreateFolder() {
  const folders = DriveApp.getFoldersByName(FOLDER_NAME);
  return folders.hasNext() ? folders.next() : DriveApp.createFolder(FOLDER_NAME);
}

/* ============================================================
   TICKET HELPERS
   ============================================================ */
function generateTicketCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let attempts = 0;

  while (attempts < 10) {
    let code = 'SJG-';
    for (let i = 0; i < 6; i++) {
      code += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    const sh = getResponsesSheet();
    const lastRow = sh.getLastRow();
    if (lastRow < 2) return code;

    const codes = sh.getRange(2, 10, lastRow - 1, 1).getValues().flat().map(String);
    if (!codes.includes(code)) return code;
    attempts++;
  }
  return 'SJG-' + Date.now().toString(36).toUpperCase();
}

function getQrCodeUrl(data, size) {
  size = size || 300;
  return 'https://quickchart.io/qr?text=' + encodeURIComponent(data) +
         '&size=' + size + '&margin=1&ecLevel=M';
}

/* ============================================================
   GUEST LOGIN
   ============================================================ */
function bootstrap() {
  try {
    const settings = getSettings();
    const deadlineStr = settings['RSVP_DEADLINE'] || '';
    const deadline = deadlineStr ? new Date(deadlineStr) : null;
    const isPastDeadline = deadline ? (new Date() > deadline) : false;

    return {
      success: true,
      deadline: deadlineStr,
      isPastDeadline: isPastDeadline
    };
  } catch (e) {
    return { success: false, message: e.toString() };
  }
}

function checkWhitelist(email) {
  try {
    const sh = getSheet(SHEET_WHITELIST, false);
    if (!sh || sh.getLastRow() <= 1) return { allowed: true };

    const values = sh.getRange(1, 1, sh.getLastRow(), 1).getValues();
    const target = String(email).trim().toLowerCase();

    for (let i = 1; i < values.length; i++) {
      const rowEmail = String(values[i][0] || '').trim().toLowerCase();
      if (rowEmail && rowEmail === target) return { allowed: true };
    }
    return { allowed: false, reason: 'This email is not on the guest list.' };
  } catch (e) {
    return { allowed: true };
  }
}

function simpleLogin(name, email) {
  try {
    name = String(name || '').trim();
    email = String(email || '').trim().toLowerCase();

    if (!name) return { success: false, message: 'Please enter your name.' };
    if (!email) return { success: false, message: 'Please enter your email.' };
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return { success: false, message: 'Please enter a valid email.' };
    }

    const check = checkWhitelist(email);
    if (!check.allowed) return { success: false, message: check.reason };

    return {
      success: true,
      user: { name: name, email: email, method: 'email' }
    };
  } catch (e) {
    return { success: false, message: e.toString() };
  }
}

/* ============================================================
   RSVP SUBMISSION
   ============================================================ */
function submitForm(formData) {
  try {
    Logger.log('=== submitForm called ===');

    const settings = getSettings();
    const deadlineStr = settings['RSVP_DEADLINE'] || '';
    if (deadlineStr) {
      const deadline = new Date(deadlineStr);
      if (new Date() > deadline) {
        return { success: false, message: 'RSVP is closed — the deadline has passed.' };
      }
    }

    if (!formData) return { success: false, message: 'No data received.' };
    if (!formData.name || !formData.name.trim()) return { success: false, message: 'Name is required.' };
    if (!formData.mobile || !formData.mobile.trim()) return { success: false, message: 'Mobile is required.' };
    if (!formData.address || !formData.address.trim()) return { success: false, message: 'Address is required.' };
    if (!formData.greetings || !formData.greetings.trim()) return { success: false, message: 'Greetings are required.' };
    if (!formData.selfie || !formData.selfie.data) return { success: false, message: 'Selfie is required.' };

    const guests = Math.max(1, Math.min(20, parseInt(formData.guests || 1, 10)));

    const sheet = getResponsesSheet();

    const folder = getOrCreateFolder();
    const parts = formData.selfie.data.split(',');
    if (parts.length < 2) return { success: false, message: 'Invalid selfie data.' };

    const meta = parts[0];
    const base64Data = parts[1];
    const contentTypeMatch = meta.match(/:(.*?);/);
    const contentType = contentTypeMatch ? contentTypeMatch[1] : 'image/jpeg';

    const bytes = Utilities.base64Decode(base64Data);
    const blob = Utilities.newBlob(bytes, contentType, formData.selfie.name || 'selfie.jpg');
    const file = folder.createFile(blob);
    try {
      file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
    } catch (e) { Logger.log('Sharing warning: ' + e.toString()); }
    const selfieUrl = file.getUrl();

    const ticketCode = generateTicketCode();

    sheet.appendRow([
      new Date(),
      formData.name.trim(),
      formData.mobile.trim(),
      formData.address.trim(),
      formData.greetings.trim(),
      selfieUrl,
      (formData.email || '').trim().toLowerCase(),
      guests,
      formData.loginMethod || 'unknown',
      ticketCode,
      ''
    ]);

    const scriptUrl = ScriptApp.getService().getUrl() || '';
    const qrData = scriptUrl
      ? scriptUrl + '?page=scan&code=' + encodeURIComponent(ticketCode)
      : ticketCode;
    const qrCodeUrl = getQrCodeUrl(qrData, 400);

    return {
      success: true,
      message: 'Thank you! Your RSVP has been received. 🎉',
      ticket: {
        code: ticketCode,
        qrCodeUrl: qrCodeUrl,
        name: formData.name.trim(),
        guests: guests,
        qrData: qrData
      }
    };
  } catch (error) {
    Logger.log('submitForm FATAL: ' + error.toString());
    return { success: false, message: 'Error: ' + error.toString() };
  }
}

/* ============================================================
   ADMIN AUTH
   ============================================================ */
function getAdminPassword() {
  const propPass = PropertiesService.getScriptProperties().getProperty('ADMIN_PASSWORD');
  if (propPass) return String(propPass).trim();

  try {
    const settings = getSettings();
    if (settings['ADMIN_PASSWORD']) return String(settings['ADMIN_PASSWORD']).trim();
  } catch (e) {}

  return '';
}

function adminLogin(password) {
  try {
    password = String(password || '');
    const expected = getAdminPassword();

    if (!expected) {
      return {
        success: false,
        message: 'Admin password not configured. Set ADMIN_PASSWORD in Script Properties.'
      };
    }

    if (password !== expected) {
      Logger.log('Admin login failed');
      return { success: false, message: 'Incorrect password.' };
    }

    Logger.log('Admin login succeeded');
    return { success: true, message: 'Welcome, admin.' };
  } catch (e) {
    return { success: false, message: e.toString() };
  }
}

/* ============================================================
   TICKET VERIFICATION (SCANNER)
   ============================================================ */
function verifyTicket(code) {
  try {
    code = String(code || '').trim().toUpperCase();
    if (!code) return { success: false, message: 'No code provided.' };

    const sh = getResponsesSheet();
    const lastRow = sh.getLastRow();
    if (lastRow < 2) return { success: false, message: 'No registrations yet.' };

    const data = sh.getRange(2, 1, lastRow - 1, 11).getValues();

    for (let i = 0; i < data.length; i++) {
      const row = data[i];
      const rowCode = String(row[9] || '').trim().toUpperCase();

      if (rowCode === code) {
        const checkedInRaw = row[10];
        const isCheckedIn = !!checkedInRaw;

        return {
          success: true,
          valid: true,
          alreadyCheckedIn: isCheckedIn,
          checkedInAt: isCheckedIn ? String(checkedInRaw) : '',
          rowIndex: i + 2,
          guest: {
            name: String(row[1] || ''),
            mobile: String(row[2] || ''),
            email: String(row[6] || ''),
            guests: parseInt(row[7] || 1, 10),
            ticketCode: rowCode,
            selfieUrl: String(row[5] || '')
          }
        };
      }
    }

    return { success: true, valid: false, message: 'Ticket not found.' };
  } catch (e) {
    Logger.log('verifyTicket error: ' + e.toString());
    return { success: false, message: e.toString() };
  }
}

function checkInTicket(code) {
  try {
    code = String(code || '').trim().toUpperCase();
    if (!code) return { success: false, message: 'No code provided.' };

    const sh = getResponsesSheet();
    const lastRow = sh.getLastRow();
    if (lastRow < 2) return { success: false, message: 'No registrations.' };

    const data = sh.getRange(2, 1, lastRow - 1, 11).getValues();

    for (let i = 0; i < data.length; i++) {
      const rowCode = String(data[i][9] || '').trim().toUpperCase();
      if (rowCode === code) {
        const rowIndex = i + 2;
        const checkedInCell = sh.getRange(rowIndex, 11);

        if (checkedInCell.getValue()) {
          return {
            success: true,
            alreadyCheckedIn: true,
            checkedInAt: String(checkedInCell.getValue()),
            guest: {
              name: String(data[i][1] || ''),
              mobile: String(data[i][2] || ''),
              email: String(data[i][6] || ''),
              guests: parseInt(data[i][7] || 1, 10),
              ticketCode: rowCode
            }
          };
        }

        checkedInCell.setValue(new Date());

        return {
          success: true,
          alreadyCheckedIn: false,
          checkedInAt: String(new Date()),
          guest: {
            name: String(data[i][1] || ''),
            mobile: String(data[i][2] || ''),
            email: String(data[i][6] || ''),
            guests: parseInt(data[i][7] || 1, 10),
            ticketCode: rowCode
          }
        };
      }
    }

    return { success: false, message: 'Ticket not found.' };
  } catch (e) {
    return { success: false, message: e.toString() };
  }
}

/* ============================================================
   SETUP — Run once from the editor
   ============================================================ */
function setupSheets() {
  const spreadsheet = ss();

  let responses = spreadsheet.getSheetByName(SHEET_RESPONSES);
  if (!responses) {
    responses = spreadsheet.insertSheet(SHEET_RESPONSES);
    responses.appendRow(RESPONSES_HEADERS);
    Logger.log('✓ Created "' + SHEET_RESPONSES + '"');
  } else {
    responses.getRange(1, 1, 1, RESPONSES_HEADERS.length).setValues([RESPONSES_HEADERS]);
    Logger.log('✓ Updated headers on "' + SHEET_RESPONSES + '"');
  }

  let settings = spreadsheet.getSheetByName(SHEET_SETTINGS);
  if (!settings) {
    settings = spreadsheet.insertSheet(SHEET_SETTINGS);
    settings.appendRow(['Key', 'Value']);
    settings.appendRow(['RSVP_DEADLINE', '']);
    settings.appendRow(['PASSWORD', '']);
    settings.appendRow(['ADMIN_PASSWORD', 'simon2026admin']);
    Logger.log('✓ Created "' + SHEET_SETTINGS + '"');
  }

  let whitelist = spreadsheet.getSheetByName(SHEET_WHITELIST);
  if (!whitelist) {
    whitelist = spreadsheet.insertSheet(SHEET_WHITELIST);
    whitelist.appendRow(['Email', 'Name']);
    Logger.log('✓ Created "' + SHEET_WHITELIST + '"');
  }

  const folder = getOrCreateFolder();
  Logger.log('✓ Drive folder: ' + folder.getUrl());

  Logger.log('=== Setup complete ===');
  return 'Setup complete.';
}

/**
 * Handle requests from GitHub Pages.
 * The action parameter tells us what to do.
 */
function doPost(e) {
  try {
    const params = e.parameter || {};
    const action = params.action;

    // --- Admin Login ---
    if (action === 'adminLogin') {
      const result = adminLogin(params.password || '');
      return jsonResponse(result);
    }

    // --- Verify Ticket ---
    if (action === 'verifyTicket') {
      const result = verifyTicket(params.code || '');
      return jsonResponse(result);
    }

    // --- Check In Ticket ---
    if (action === 'checkInTicket') {
      const result = checkInTicket(params.code || '');
      return jsonResponse(result);
    }

    return jsonResponse({ success: false, message: 'Unknown action: ' + action });
  } catch (err) {
    return jsonResponse({ success: false, message: err.toString() });
  }
}

function jsonResponse(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}
