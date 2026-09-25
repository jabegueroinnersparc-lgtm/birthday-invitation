/**
 * Birthday Invitation — Backend
 * Handles:
 *   - Apps Script HTML service (doGet)
 *   - Vercel / GitHub Pages frontend via fetch() (doPost)
 *
 * Attendance values: 'going' | 'planning' | 'not_going'
 */

const SHEET_RESPONSES = 'Responses';
const SHEET_WHITELIST = 'Whitelist';
const SHEET_SETTINGS  = 'Settings';
const FOLDER_NAME     = 'Birthday Selfies';

const RESPONSES_HEADERS = [
  'Timestamp', 'Name', 'Mobile', 'Address', 'Greetings',
  'Selfie URL', 'Email', 'Guests', 'Login Method',
  'Ticket Code', 'Checked In', 'Attendance'
];

/* ============================================================
   WEB APP ENTRY (GET)
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
   PARAM PARSER
   ============================================================ */
function parseParams(e) {
  const params = {};

  if (e && e.parameter) {
    Object.keys(e.parameter).forEach(function(k) {
      params[k] = e.parameter[k];
    });
  }

  if (e && e.postData && e.postData.contents) {
    const body = e.postData.contents;
    if (body) {
      const pairs = body.split('&');
      pairs.forEach(function(pair) {
        const idx = pair.indexOf('=');
        if (idx > 0) {
          const key = decodeURIComponent(pair.substring(0, idx).replace(/\+/g, ' '));
          const val = decodeURIComponent(pair.substring(idx + 1).replace(/\+/g, ' '));
          if (params[key] === undefined) {
            params[key] = val;
          }
        }
      });
    }
  }

  if (e && e.postData && e.postData.contents && !params.action) {
    try {
      const parsed = JSON.parse(e.postData.contents);
      if (parsed && parsed.action) {
        Object.keys(parsed).forEach(function(k) {
          params[k] = parsed[k];
        });
      }
    } catch (err) { /* not JSON, ignore */ }
  }

  return params;
}

/* ============================================================
   API ENTRY (POST)
   ============================================================ */
function doPost(e) {
  try {
    const params = parseParams(e);
    const action = params.action;

    Logger.log('doPost called: action=' + action);

    if (action === 'bootstrap') {
      return jsonResponse(bootstrap());
    }

    if (action === 'simpleLogin') {
      return jsonResponse(simpleLogin(params.name || ''));
    }

    if (action === 'submitForm') {
      let formData = {};
      try {
        formData = JSON.parse(params.data || '{}');
      } catch (err) {
        return jsonResponse({ success: false, message: 'Invalid form data.' });
      }
      return jsonResponse(submitForm(formData));
    }

    if (action === 'adminLogin') {
      return jsonResponse(adminLogin(params.password || ''));
    }

    if (action === 'verifyTicket') {
      return jsonResponse(verifyTicket(params.code || ''));
    }

    if (action === 'checkInTicket') {
      return jsonResponse(checkInTicket(params.code || ''));
    }

    if (action === 'checkExistingRSVP') {
      return jsonResponse(checkExistingRSVP(params.name || params.email || ''));
    }

    if (action === 'getAllAttendees') {
      return jsonResponse(getAllAttendees());
    }

    return jsonResponse({ success: false, message: 'Unknown action: ' + action });
  } catch (err) {
    Logger.log('doPost error: ' + err.toString());
    return jsonResponse({ success: false, message: err.toString() });
  }
}

function jsonResponse(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
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

/** Normalize names so case and repeated spaces cannot bypass duplicate checks. */
function normalizeName(value) {
  return String(value || '').replace(/\s+/g, ' ').trim().toLowerCase();
}

/** Find an existing RSVP by normalized player name. */
function findResponseByName(name) {
  const target = normalizeName(name);
  if (!target) return null;

  const sh = getResponsesSheet();
  const lastRow = sh.getLastRow();
  if (lastRow < 2) return null;

  const data = sh.getRange(2, 1, lastRow - 1, 12).getValues();
  for (let i = 0; i < data.length; i++) {
    if (normalizeName(data[i][1]) === target) {
      return {
        row: i + 2,
        name: String(data[i][1] || '').trim(),
        code: String(data[i][9] || '').trim()
      };
    }
  }
  return null;
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
   GUEST LOGIN (name only)
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

/**
 * Finds a whitelist row by name.
 * Returns { email, name } or null.
 */
function findWhitelistAccount(name) {
  const whitelist = getSheet(SHEET_WHITELIST, false);
  if (!whitelist || whitelist.getLastRow() < 2) return null;

  const values = whitelist.getRange(2, 1, whitelist.getLastRow() - 1, 2).getValues();
  const target = normalizeName(name);

  for (let i = 0; i < values.length; i++) {
    const rowName = normalizeName(values[i][1]);
    if (rowName === target) {
      return {
        email: String(values[i][0] || '').trim().toLowerCase(),
        name: String(values[i][1] || '').trim()
      };
    }
  }
  return null;
}

/**
 * Simple login: name only.
 *   - If name exists in Whitelist → { exists: true } (client shows error).
 *   - Otherwise create the row and return { success: true, user }.
 */
function simpleLogin(name) {
  try {
    name = String(name || '').trim();

    if (!name) return { success: false, message: 'Please enter your name.' };
    if (name.length < 2) return { success: false, message: 'Please enter a valid name.' };

    const lock = LockService.getScriptLock();
    lock.waitLock(10000);
    try {
      const existing = findWhitelistAccount(name);
      if (existing) {
        return {
          success: false,
          exists: true,
          message: 'This name is already logged in. Please try another name.'
        };
      }

      const whitelist = getSheet(SHEET_WHITELIST, true);
      if (whitelist.getLastRow() === 0) {
        whitelist.appendRow(['Email', 'Name']);
      }

      // Store the name in both columns so existing lookups keep working.
      whitelist.appendRow([name, name]);

      Logger.log('Created guest account for ' + name + '.');

      return {
        success: true,
        created: true,
        user: { name: name, email: name, method: 'name' }
      };
    } finally {
      lock.releaseLock();
    }
  } catch (e) {
    Logger.log('simpleLogin error: ' + e.toString());
    return { success: false, message: 'Unable to sign in.' };
  }
}

/* ============================================================
   EXISTING RSVP CHECK (by name)
   ============================================================ */
function checkExistingRSVP(nameOrEmail) {
  try {
    const target = String(nameOrEmail || '').trim().toLowerCase();
    if (!target) return { success: false, message: 'No name provided.' };

    const sh = getResponsesSheet();
    const lastRow = sh.getLastRow();
    if (lastRow < 2) return { success: true, exists: false };

    const data = sh.getRange(2, 1, lastRow - 1, 12).getValues();

    for (let i = 0; i < data.length; i++) {
      const rowEmail = String(data[i][6] || '').trim().toLowerCase();
      const rowName = String(data[i][1] || '').trim().toLowerCase();

      // Match against either the name column or the email column (fallback for old rows).
      if ((rowName && rowName === target) || (rowEmail && rowEmail === target)) {
        const scriptUrl = ScriptApp.getService().getUrl() || '';
        const ticketCode = String(data[i][9] || '').trim();
        const qrData = scriptUrl
          ? scriptUrl + '?page=scan&code=' + encodeURIComponent(ticketCode)
          : ticketCode;

        return {
          success: true,
          exists: true,
          ticket: {
            code: ticketCode,
            qrCodeUrl: getQrCodeUrl(qrData, 400),
            name: String(data[i][1] || ''),
            guests: parseInt(data[i][7] || 1, 10),
            qrData: qrData,
            attendance: String(data[i][11] || 'going').trim().toLowerCase()
          }
        };
      }
    }

    return { success: true, exists: false };
  } catch (e) {
    Logger.log('checkExistingRSVP error: ' + e.toString());
    return { success: false, message: e.toString() };
  }
}

/* ============================================================
   GET ALL ATTENDEES
   ============================================================ */
function getAllAttendees() {
  try {
    const sh = getResponsesSheet();
    const lastRow = sh.getLastRow();
    if (lastRow < 2) {
      return { success: true, attendees: [], totalGuests: 0, totalParties: 0 };
    }

    const data = sh.getRange(2, 1, lastRow - 1, 12).getValues();

    const attendees = [];
    let totalGuests = 0;

    for (let i = 0; i < data.length; i++) {
      const name = String(data[i][1] || '').trim();
      const guests = parseInt(data[i][7] || 1, 10);
      const attendance = String(data[i][11] || 'going').trim().toLowerCase();

      if (name) {
        const nameParts = name.split(' ');
        const firstName = nameParts[0];
        const lastInitial = nameParts.length > 1
          ? nameParts[nameParts.length - 1].charAt(0).toUpperCase() + '.'
          : '';
        const displayName = lastInitial ? firstName + ' ' + lastInitial : firstName;

        attendees.push({
          name: displayName,
          guests: guests,
          attendance: attendance
        });

        if (attendance === 'going') {
          totalGuests += guests;
        }
      }
    }

    attendees.reverse();

    return {
      success: true,
      attendees: attendees,
      totalGuests: totalGuests,
      totalParties: attendees.length
    };
  } catch (e) {
    Logger.log('getAllAttendees error: ' + e.toString());
    return { success: false, message: e.toString(), attendees: [] };
  }
}

/* ============================================================
   RSVP SUBMISSION
   ============================================================ */
function submitForm(formData) {
  const lock = LockService.getScriptLock();

  try {
    Logger.log('=== submitForm called ===');

    const settings = getSettings();
    const deadlineStr = settings['RSVP_DEADLINE'] || '';
    if (deadlineStr) {
      const deadline = new Date(deadlineStr);
      if (new Date() > deadline) {
        return { success: false, message: 'Confirmations are closed — the deadline has passed.' };
      }
    }

    if (!formData) return { success: false, message: 'No data received.' };

    const submittedName = String(formData.name || '').replace(/\s+/g, ' ').trim();
    if (!submittedName) return { success: false, message: 'Name is required.' };
    if (submittedName.length < 2) return { success: false, message: 'Please enter a valid name.' };
    if (!formData.mobile || !String(formData.mobile).trim()) return { success: false, message: 'Mobile is required.' };
    if (!formData.address || !String(formData.address).trim()) return { success: false, message: 'Address is required.' };
    if (!formData.greetings || !String(formData.greetings).trim()) return { success: false, message: 'Greetings are required.' };
    if (!formData.selfie || !formData.selfie.data) return { success: false, message: 'Selfie is required.' };

    const attendance = String(formData.attendance || 'going').trim().toLowerCase();
    const validAttendance = ['going', 'planning', 'not_going'];
    if (!validAttendance.includes(attendance)) {
      return { success: false, message: 'Please choose an attendance option.' };
    }

    // Do not use parseInt here: values such as "2abc" or "letters" must be rejected.
    const guestsText = String(formData.guests == null ? '' : formData.guests).trim();
    if (!/^\d+$/.test(guestsText)) {
      return { success: false, message: 'Please enter a valid number of guests.' };
    }
    const guests = Number(guestsText);
    if (!Number.isInteger(guests) || guests < 1 || guests > 20) {
      return { success: false, message: 'Please enter a whole number of guests from 1 to 20.' };
    }

    // Keep the duplicate check and append inside one script lock. This prevents
    // two simultaneous submissions with the same name from both being saved.
    lock.waitLock(30000);
    try {
      const duplicate = findResponseByName(submittedName);
      if (duplicate) {
        return {
          success: false,
          duplicate: true,
          message: 'This name has already submitted an RSVP. Each player may submit only once.'
        };
      }

      const sheet = getResponsesSheet();
      const folder = getOrCreateFolder();
      const parts = String(formData.selfie.data).split(',');
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
      const identifier = String(formData.email || submittedName).trim();

      sheet.appendRow([
        new Date(),
        submittedName,
        String(formData.mobile).trim(),
        String(formData.address).trim(),
        String(formData.greetings).trim(),
        selfieUrl,
        identifier,
        guests,
        formData.loginMethod || 'name',
        ticketCode,
        '',
        attendance
      ]);

      const scriptUrl = ScriptApp.getService().getUrl() || '';
      const qrData = scriptUrl
        ? scriptUrl + '?page=scan&code=' + encodeURIComponent(ticketCode)
        : ticketCode;
      const qrCodeUrl = getQrCodeUrl(qrData, 400);

      return {
        success: true,
        message: 'Thank you! Your attendance is confirmed. 🎉',
        ticket: {
          code: ticketCode,
          qrCodeUrl: qrCodeUrl,
          name: submittedName,
          guests: guests,
          qrData: qrData,
          attendance: attendance
        }
      };
    } finally {
      lock.releaseLock();
    }
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

    const data = sh.getRange(2, 1, lastRow - 1, 12).getValues();

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
            selfieUrl: String(row[5] || ''),
            attendance: String(row[11] || 'going').trim().toLowerCase()
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

    const data = sh.getRange(2, 1, lastRow - 1, 12).getValues();

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
    settings.appendRow(['ADMIN_PASSWORD', 'sairacute.']);
    Logger.log('✓ Created "' + SHEET_SETTINGS + '"');
  }

  let whitelist = spreadsheet.getSheetByName(SHEET_WHITELIST);
  if (!whitelist) {
    whitelist = spreadsheet.insertSheet(SHEET_WHITELIST);
    whitelist.appendRow(['Email', 'Name']);
    Logger.log('✓ Created "' + SHEET_WHITELIST + '"');
  } else {
    whitelist.getRange(1, 1, 1, 2).setValues([['Email', 'Name']]);
    Logger.log('✓ Updated headers on "' + SHEET_WHITELIST + '"');
  }

  const folder = getOrCreateFolder();
  Logger.log('✓ Drive folder: ' + folder.getUrl());

  Logger.log('=== Setup complete ===');
  return 'Setup complete.';
}

/* ============================================================
   RESET ALL DATA — Run once from the editor
   ------------------------------------------------------------
   Wipes all guest responses, whitelist entries, uploaded selfies,
   and resets the Settings sheet to defaults.

   WARNING: This is destructive and cannot be undone.
   ============================================================ */
function resetAllData() {
  const ui = SpreadsheetApp.getUi();

  const confirm = ui.alert(
    'Reset ALL data?',
    'This will permanently delete:\n\n' +
    '• All rows in the "Responses" sheet\n' +
    '• All rows in the "Whitelist" sheet\n' +
    '• All files in the "Birthday Selfies" Drive folder\n' +
    '• Reset the "Settings" sheet to defaults\n\n' +
    'This CANNOT be undone. Continue?',
    ui.ButtonSet.YES_NO
  );

  if (confirm !== ui.Button.YES) {
    Logger.log('Reset cancelled by user.');
    return 'Reset cancelled.';
  }

  const spreadsheet = ss();
  const summary = {
    responsesDeleted: 0,
    whitelistDeleted: 0,
    selfiesDeleted: 0,
    settingsReset: false
  };

  /* -------- 1. Clear the Responses sheet -------- */
  try {
    const responses = spreadsheet.getSheetByName(SHEET_RESPONSES);
    if (responses) {
      const lastRow = responses.getLastRow();
      if (lastRow > 1) {
        summary.responsesDeleted = lastRow - 1;
        responses.deleteRows(2, lastRow - 1);
      }
      responses.getRange(1, 1, 1, RESPONSES_HEADERS.length)
        .setValues([RESPONSES_HEADERS]);
      Logger.log('✓ Cleared Responses sheet (' + summary.responsesDeleted + ' rows).');
    }
  } catch (e) {
    Logger.log('Could not clear Responses: ' + e.toString());
  }

  /* -------- 2. Clear the Whitelist sheet -------- */
  try {
    const whitelist = spreadsheet.getSheetByName(SHEET_WHITELIST);
    if (whitelist) {
      const lastRow = whitelist.getLastRow();
      if (lastRow > 1) {
        summary.whitelistDeleted = lastRow - 1;
        whitelist.deleteRows(2, lastRow - 1);
      }
      whitelist.getRange(1, 1, 1, 2).setValues([['Email', 'Name']]);
      Logger.log('✓ Cleared Whitelist sheet (' + summary.whitelistDeleted + ' rows).');
    }
  } catch (e) {
    Logger.log('Could not clear Whitelist: ' + e.toString());
  }

  /* -------- 3. Delete all files in the selfie Drive folder -------- */
  try {
    const folders = DriveApp.getFoldersByName(FOLDER_NAME);
    if (folders.hasNext()) {
      const folder = folders.next();
      const files = folder.getFiles();
      while (files.hasNext()) {
        const file = files.next();
        try {
          file.setTrashed(true);
          summary.selfiesDeleted++;
        } catch (e) {
          Logger.log('Could not trash file ' + file.getName() + ': ' + e.toString());
        }
      }
      Logger.log('✓ Deleted ' + summary.selfiesDeleted + ' selfie file(s).');
    } else {
      Logger.log('No "' + FOLDER_NAME + '" folder found — nothing to delete.');
    }
  } catch (e) {
    Logger.log('Could not delete selfies: ' + e.toString());
  }

  /* -------- 4. Reset the Settings sheet -------- */
  try {
    const settings = spreadsheet.getSheetByName(SHEET_SETTINGS);
    if (settings) {
      const lastRow = settings.getLastRow();
      if (lastRow > 1) {
        settings.deleteRows(2, lastRow - 1);
      }
      settings.getRange(1, 1, 1, 2).setValues([['Key', 'Value']]);
      settings.appendRow(['RSVP_DEADLINE', '']);
      settings.appendRow(['ADMIN_PASSWORD', 'sairacute.']);
      summary.settingsReset = true;
      Logger.log('✓ Settings sheet reset to defaults.');
    }
  } catch (e) {
    Logger.log('Could not reset Settings: ' + e.toString());
  }

  Logger.log('=== Reset complete ===');
  Logger.log(JSON.stringify(summary));

  ui.alert(
    'Reset complete',
    'Responses deleted: ' + summary.responsesDeleted + '\n' +
    'Whitelist entries deleted: ' + summary.whitelistDeleted + '\n' +
    'Selfie files deleted: ' + summary.selfiesDeleted + '\n' +
    'Settings reset: ' + (summary.settingsReset ? 'yes' : 'no'),
    ui.ButtonSet.OK
  );

  return 'Reset complete.';
}
