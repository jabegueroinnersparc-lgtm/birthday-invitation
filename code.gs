/**
 * Birthday Invitation — Backend
 * Handles:
 *   - Apps Script HTML service (doGet)
 *   - Vercel / GitHub Pages frontend via fetch() (doPost)
 *
 * doPost handles both:
 *   - e.parameter (URL query params)
 *   - e.postData.contents (raw POST body) — parsed manually
 *
 * Attendance values: 'going' | 'planning' | 'not_going'
 */

const SHEET_RESPONSES = 'Responses';
const SHEET_WHITELIST = 'Whitelist';
const SHEET_PASSWORDS = 'GuestPasswords';
const SHEET_SETTINGS  = 'Settings';
const FOLDER_NAME     = 'Birthday Selfies';
const PASSWORD_HASH_ITERATIONS = 12000;

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
      return jsonResponse(simpleLogin(
        params.name || '',
        params.email || '',
        params.password || ''
      ));
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
      return jsonResponse(checkExistingRSVP(params.email || ''));
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

function createPasswordSheet() {
  const spreadsheet = ss();
  let passwords = spreadsheet.getSheetByName(SHEET_PASSWORDS);
  if (!passwords) {
    passwords = spreadsheet.insertSheet(SHEET_PASSWORDS);
    passwords.appendRow(['Email', 'Password Salt', 'Password Hash']);
    Logger.log('✓ Created "' + SHEET_PASSWORDS + '"');
  } else {
    passwords.getRange(1, 1, 1, 3)
      .setValues([['Email', 'Password Salt', 'Password Hash']]);
  }
  return passwords;
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

function bytesToHex(bytes) {
  return bytes.map(function(byte) {
    const value = byte < 0 ? byte + 256 : byte;
    return ('0' + value.toString(16)).slice(-2);
  }).join('');
}

function hashGuestPassword(password, salt) {
  let value = String(salt) + ':' + String(password);
  for (let i = 0; i < PASSWORD_HASH_ITERATIONS; i++) {
    const digest = Utilities.computeDigest(
      Utilities.DigestAlgorithm.SHA_256,
      value,
      Utilities.Charset.UTF_8
    );
    value = bytesToHex(digest);
  }
  return value;
}

function constantTimeEqual(a, b) {
  a = String(a || '');
  b = String(b || '');
  let result = a.length ^ b.length;
  const length = Math.max(a.length, b.length);
  for (let i = 0; i < length; i++) {
    result |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  }
  return result === 0;
}

function getWhitelistAccount(email) {
  const whitelist = getSheet(SHEET_WHITELIST, false);
  if (!whitelist || whitelist.getLastRow() < 2) return null;

  const values = whitelist.getRange(2, 1, whitelist.getLastRow() - 1, 2).getValues();
  const target = String(email || '').trim().toLowerCase();
  let account = null;

  for (let i = 0; i < values.length; i++) {
    const rowEmail = String(values[i][0] || '').trim().toLowerCase();
    if (rowEmail === target) {
      account = {
        email: rowEmail,
        name: String(values[i][1] || '').trim()
      };
      break;
    }
  }

  if (!account) return null;

  const passwordSheet = getSheet(SHEET_PASSWORDS, false);
  if (!passwordSheet || passwordSheet.getLastRow() < 2) return account;

  // GuestPasswords columns: A Email, B Password Salt, C Password Hash.
  const passwordRows = passwordSheet.getRange(2, 1, passwordSheet.getLastRow() - 1, 3).getValues();
  for (let i = 0; i < passwordRows.length; i++) {
    const rowEmail = String(passwordRows[i][0] || '').trim().toLowerCase();
    if (rowEmail === target) {
      account.salt = String(passwordRows[i][1] || '').trim();
      account.hash = String(passwordRows[i][2] || '').trim();
      break;
    }
  }
  return account;
}

function createGuestAccount(name, email, password) {
  const whitelist = getSheet(SHEET_WHITELIST, true);
  if (whitelist.getLastRow() === 0) {
    whitelist.appendRow(['Email', 'Name']);
  }

  const passwords = createPasswordSheet();
  const salt = Utilities.getUuid().replace(/-/g, '');
  const hash = hashGuestPassword(password, salt);

  whitelist.appendRow([email, name]);
  passwords.appendRow([email, salt, hash]);

  Logger.log('Created guest account for ' + email + '.');
  return {
    success: true,
    created: true,
    passwordVerified: true,
    user: { name: name, email: email, method: 'password' }
  };
}

function simpleLogin(name, email, password) {
  try {
    name = String(name || '').trim();
    email = String(email || '').trim().toLowerCase();
    password = String(password || '');

    if (!name) return { success: false, message: 'Please enter your name.' };
    if (!email) return { success: false, message: 'Please enter your email.' };
    if (!password) return { success: false, message: 'Please enter your password.' };
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return { success: false, message: 'Please enter a valid email.' };
    }

    const account = getWhitelistAccount(email);
    if (!account) {
      // First-time users are registered automatically. The script lock prevents
      // two simultaneous requests from creating duplicate rows.
      const lock = LockService.getScriptLock();
      lock.waitLock(10000);
      try {
        const existingAccount = getWhitelistAccount(email);
        if (existingAccount) {
          const existingHash = existingAccount.hash;
          if (!existingAccount.salt || !existingHash) {
            return { success: false, passwordConfigured: false, passwordVerified: false };
          }
          const existingCandidate = hashGuestPassword(password, existingAccount.salt);
          if (!constantTimeEqual(existingCandidate, existingHash)) {
            return { success: false, passwordVerified: false, message: 'Invalid credentials.' };
          }
          return {
            success: true,
            passwordVerified: true,
            user: { name: existingAccount.name || name, email: email, method: 'password' }
          };
        }
        return createGuestAccount(name, email, password);
      } finally {
        lock.releaseLock();
      }
    }

    if (!account || !account.salt || !account.hash) {
      Logger.log('Password not configured for guest: ' + email);
      return { success: false, passwordConfigured: false, passwordVerified: false };
    }

    const candidateHash = hashGuestPassword(password, account.salt);
    if (!constantTimeEqual(candidateHash, account.hash)) {
      Logger.log('Guest login failed for: ' + email);
      return { success: false, passwordVerified: false, message: 'Invalid credentials.' };
    }

    // Use the server-side name, not the user-supplied name, after authentication.
    const authenticatedName = account.name || name;

    return {
      success: true,
      passwordVerified: true,
      user: { name: authenticatedName, email: email, method: 'password' }
    };
  } catch (e) {
    Logger.log('simpleLogin error: ' + e.toString());
    return { success: false, passwordVerified: false, message: 'Unable to sign in.' };
  }
}

/* ============================================================
   EXISTING RSVP CHECK
   ============================================================ */
function checkExistingRSVP(email) {
  try {
    email = String(email || '').trim().toLowerCase();
    if (!email) return { success: false, message: 'No email provided.' };

    const sh = getResponsesSheet();
    const lastRow = sh.getLastRow();
    if (lastRow < 2) return { success: true, exists: false };

    const data = sh.getRange(2, 1, lastRow - 1, 12).getValues();

    for (let i = 0; i < data.length; i++) {
      const rowEmail = String(data[i][6] || '').trim().toLowerCase();
      if (rowEmail && rowEmail === email) {
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
    if (!formData.name || !formData.name.trim()) return { success: false, message: 'Name is required.' };
    if (!formData.mobile || !formData.mobile.trim()) return { success: false, message: 'Mobile is required.' };
    if (!formData.address || !formData.address.trim()) return { success: false, message: 'Address is required.' };
    if (!formData.greetings || !formData.greetings.trim()) return { success: false, message: 'Greetings are required.' };
    if (!formData.selfie || !formData.selfie.data) return { success: false, message: 'Selfie is required.' };

    const attendance = String(formData.attendance || 'going').trim().toLowerCase();
    const validAttendance = ['going', 'planning', 'not_going'];
    if (!validAttendance.includes(attendance)) {
      return { success: false, message: 'Please choose an attendance option.' };
    }

    const email = (formData.email || '').trim().toLowerCase();
    if (email) {
      const dup = checkExistingRSVP(email);
      if (dup && dup.success && dup.exists) {
        return {
          success: false,
          message: 'You already confirmed with this email.',
          duplicate: true,
          ticket: dup.ticket
        };
      }
    }

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
      email,
      guests,
      formData.loginMethod || 'unknown',
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
        name: formData.name.trim(),
        guests: guests,
        qrData: qrData,
        attendance: attendance
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
    settings.appendRow(['PASSWORD', '']);
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

  createPasswordSheet();

  const folder = getOrCreateFolder();
  Logger.log('✓ Drive folder: ' + folder.getUrl());

  Logger.log('=== Setup complete ===');
  return 'Setup complete.';
}

/* ============================================================
   GUEST PASSWORD SETUP
   Run setGuestPassword once for each guest from the Apps Script editor.
   Example: setGuestPassword('maria@example.com', 'a-long-password');
   The plaintext password is never saved to the sheet.
   ============================================================ */
function setGuestPassword(email, password) {
  email = String(email || '').trim().toLowerCase();
  password = String(password || '');

  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new Error('Enter a valid guest email.');
  }
  if (password.length < 8) {
    throw new Error('Password must be at least 8 characters.');
  }

  const whitelist = getSheet(SHEET_WHITELIST, false);
  if (!whitelist || whitelist.getLastRow() < 2) throw new Error('Add the guest to the Whitelist sheet first.');

  const emails = whitelist.getRange(2, 1, whitelist.getLastRow() - 1, 1).getValues();
  for (let i = 0; i < emails.length; i++) {
    const rowEmail = String(emails[i][0] || '').trim().toLowerCase();
    if (rowEmail === email) {
      const salt = Utilities.getUuid().replace(/-/g, '');
      const hash = hashGuestPassword(password, salt);
      const passwords = createPasswordSheet();

      const passwordRows = passwords.getLastRow() > 1
        ? passwords.getRange(2, 1, passwords.getLastRow() - 1, 3).getValues()
        : [];
      for (let j = 0; j < passwordRows.length; j++) {
        if (String(passwordRows[j][0] || '').trim().toLowerCase() === email) {
          passwords.getRange(j + 2, 1, 1, 3).setValues([[email, salt, hash]]);
          Logger.log('Password saved for ' + email + '.');
          return 'Password saved for ' + email + '.';
        }
      }

      passwords.appendRow([email, salt, hash]);
      Logger.log('Password saved for ' + email + '.');
      return 'Password saved for ' + email + '.';
    }
  }

  throw new Error('Guest email was not found in the Whitelist sheet.');
}
