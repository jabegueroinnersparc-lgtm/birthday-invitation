/**
 * Birthday Invitation — Backend
 * Handles:
 *   - Apps Script HTML service (doGet)
 *   - Vercel / GitHub Pages frontend via fetch() (doPost)
 *
 * Attendance values: 'going' | 'planning' | 'not_going'
 *
 * ⭐ UPDATED: Supports video greetings for guests who can't attend.
 */

const SHEET_RESPONSES = 'Responses';
const SHEET_WHITELIST = 'Whitelist';
const SHEET_SETTINGS  = 'Settings';
const FOLDER_NAME     = 'Birthday Selfies';
const VIDEO_FOLDER_NAME = 'Birthday Video Greetings';  // ⭐ NEW
const SHEET_PAYMENTS   = 'Payments';

const PAYMENT_HEADERS = [
  'Timestamp', 'Name', 'Mobile', 'Amount', 'Transaction Reference', 'Notes', 'Status'
];

// Short-lived caches reduce repeated full-sheet reads while keeping new
// signups and RSVPs visible quickly after they are written.
const CACHE_TTL_SECONDS = 30;
const WHITELIST_CACHE_KEY = 'birthday_whitelist_v1';
const ATTENDEES_CACHE_KEY = 'birthday_attendees_v1';
const SETTINGS_CACHE_KEY = 'birthday_settings_v1';

// ⭐ CHANGED: Added "Video Greeting URL" column.
// Order: ...Selfie URL, Email, Guests, Login Method, Ticket Code, Checked In, Attendance, Video Greeting URL
const RESPONSES_HEADERS = [
  'Timestamp', 'Name', 'Mobile', 'Address', 'Greetings',
  'Selfie URL', 'Email', 'Guests', 'Login Method',
  'Ticket Code', 'Checked In', 'Attendance', 'Video Greeting URL'
];

// Column index helper (1-based → 0-based for getValues arrays)
const COL = {
  TIMESTAMP:    0,
  NAME:         1,
  MOBILE:       2,
  ADDRESS:      3,
  GREETINGS:    4,
  SELFIE_URL:   5,
  EMAIL:        6,
  GUESTS:       7,
  LOGIN_METHOD: 8,
  TICKET_CODE:  9,
  CHECKED_IN:   10,
  ATTENDANCE:   11,
  VIDEO_URL:    12   // ⭐ NEW
};

/* ============================================================
   WEB APP ENTRY (GET)
   ============================================================ */
function doGet(e) {
  if (e && e.parameter && e.parameter.action) {
    return handleApiRequest(e);
  }

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
   CORS PREFLIGHT HANDLER
   ============================================================ */
function doOptions(e) {
  return ContentService.createTextOutput('')
    .setMimeType(ContentService.MimeType.TEXT);
}

/* ============================================================
   PARAM PARSER — JSON-first (new frontend), URL-encoded (legacy)
   ============================================================ */
function parseParams(e) {
  const params = {};

  // 1. Query string params
  if (e && e.parameter) {
    Object.keys(e.parameter).forEach(function(k) {
      params[k] = e.parameter[k];
    });
  }

  // 2. POST body — try JSON first
  if (e && e.postData && e.postData.contents) {
    const body = e.postData.contents;

    // ⭐ Try JSON first (new frontend sends application/json)
    try {
      const parsed = JSON.parse(body);
      if (parsed && parsed.action) {
        Object.keys(parsed).forEach(function(k) {
          params[k] = parsed[k];
        });
        return params;
      }
    } catch (err) { /* not JSON — fall through to URL-encoded */ }

    // Fallback: URL-encoded (legacy)
    if (body && body.indexOf('=') !== -1) {
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

  return params;
}

/* ============================================================
   API ENTRY (POST)
   ============================================================ */
function doPost(e) {
  return handleApiRequest(e);
}

function handleApiRequest(e) {
  try {
    const params = parseParams(e);
    const action = params.action;

    Logger.log('handleApiRequest: action=' + action);

    if (action === 'bootstrap')       return jsonResponse(bootstrap());
    if (action === 'simpleLogin')     return jsonResponse(simpleLogin(params.name || '', params.mobile || ''));
    if (action === 'loginByMobile')   return jsonResponse(loginByMobile(params.mobile || ''));

    if (action === 'submitForm') {
      let formData = {};
      try {
        formData = JSON.parse(params.data || '{}');
      } catch (err) {
        return jsonResponse({ success: false, message: 'Invalid form data.' });
      }
      return jsonResponse(submitForm(formData));
    }

    if (action === 'adminLogin')      return jsonResponse(adminLogin(params.password || ''));
    if (action === 'verifyTicket')    return jsonResponse(verifyTicket(params.code || ''));
    if (action === 'checkInTicket')   return jsonResponse(checkInTicket(params.code || ''));

    if (action === 'checkExistingRSVP') {
      return jsonResponse(checkExistingRSVP(
        params.name || params.email || '',
        params.mobile || ''
      ));
    }

    if (action === 'getAllAttendees') return jsonResponse(getAllAttendees());

    if (action === 'submitPayment') {
      let paymentData = {};
      try {
        paymentData = JSON.parse(params.data || '{}');
      } catch (err) {
        return jsonResponse({ success: false, message: 'Invalid payment data.' });
      }
      return jsonResponse(submitPayment(paymentData));
    }

    return jsonResponse({ success: false, message: 'Unknown action: ' + action });
  } catch (err) {
    Logger.log('handleApiRequest error: ' + err.toString());
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
    const headerRow = sh.getRange(1, 1, 1, Math.max(sh.getLastColumn(), RESPONSES_HEADERS.length)).getValues()[0];
    // ⭐ CHANGED: Always ensure the header row matches (handles new column addition)
    if (headerRow.length < RESPONSES_HEADERS.length) {
      sh.getRange(1, 1, 1, RESPONSES_HEADERS.length).setValues([RESPONSES_HEADERS]);
    }
  }
  return sh;
}

function getSettings() {
  const cache = CacheService.getScriptCache();
  const cached = cache.get(SETTINGS_CACHE_KEY);
  if (cached) {
    try { return JSON.parse(cached); } catch (e) {}
  }

  const sh = getSheet(SHEET_SETTINGS, true);
  if (!sh || sh.getLastRow() < 2) return {};
  const values = sh.getRange(1, 1, sh.getLastRow(), 2).getValues();
  const map = {};
  for (let i = 1; i < values.length; i++) {
    const key = String(values[i][0] || '').trim();
    const val = String(values[i][1] || '').trim();
    if (key) map[key] = val;
  }
  try { cache.put(SETTINGS_CACHE_KEY, JSON.stringify(map), CACHE_TTL_SECONDS); } catch (e) {}
  return map;
}

function clearBirthdayCaches() {
  try {
    CacheService.getScriptCache().removeAll([
      WHITELIST_CACHE_KEY,
      ATTENDEES_CACHE_KEY,
      SETTINGS_CACHE_KEY
    ]);
  } catch (e) {}
}

function getWhitelistValues() {
  const cache = CacheService.getScriptCache();
  const cached = cache.get(WHITELIST_CACHE_KEY);
  if (cached) {
    try { return JSON.parse(cached); } catch (e) {}
  }

  const whitelist = getSheet(SHEET_WHITELIST, false);
  if (!whitelist || whitelist.getLastRow() < 2) return [];
  const values = whitelist.getRange(2, 1, whitelist.getLastRow() - 1, 3).getValues();
  try { cache.put(WHITELIST_CACHE_KEY, JSON.stringify(values), CACHE_TTL_SECONDS); } catch (e) {}
  return values;
}

function getOrCreateFolder() {
  const folders = DriveApp.getFoldersByName(FOLDER_NAME);
  return folders.hasNext() ? folders.next() : DriveApp.createFolder(FOLDER_NAME);
}

// ⭐ NEW: Separate folder for video greetings
function getOrCreateVideoFolder() {
  const folders = DriveApp.getFoldersByName(VIDEO_FOLDER_NAME);
  return folders.hasNext() ? folders.next() : DriveApp.createFolder(VIDEO_FOLDER_NAME);
}

/** Normalize names so case and repeated spaces cannot bypass duplicate checks. */
function normalizeName(value) {
  return String(value || '').replace(/\s+/g, ' ').trim().toLowerCase();
}

/**
 * Normalize mobile values for comparison.
 */
function normalizeMobile(value) {
  let digits = String(value || '').replace(/\D/g, '').trim();
  if (digits.indexOf('63') === 0 && digits.length === 12) {
    digits = '0' + digits.substring(2);
  } else if (digits.length === 10 && digits.indexOf('9') === 0) {
    digits = '0' + digits;
  }
  return digits;
}

/** Find an existing RSVP by normalized player name. */
function findResponseByName(name) {
  const target = normalizeName(name);
  if (!target) return null;

  const sh = getResponsesSheet();
  const lastRow = sh.getLastRow();
  if (lastRow < 2) return null;

  const data = sh.getRange(2, 1, lastRow - 1, RESPONSES_HEADERS.length).getValues();
  for (let i = 0; i < data.length; i++) {
    if (normalizeName(data[i][COL.NAME]) === target) {
      return {
        row: i + 2,
        name: String(data[i][COL.NAME] || '').trim(),
        code: String(data[i][COL.TICKET_CODE] || '').trim()
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

    const codes = sh.getRange(2, COL.TICKET_CODE + 1, lastRow - 1, 1).getValues().flat().map(String);
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

function findWhitelistAccount(name, mobile) {
  const values = getWhitelistValues();
  if (!values.length) return null;
  const target = normalizeName(name);
  const targetMobile = normalizeMobile(mobile);
  if (!target || !targetMobile) return null;

  for (let i = 0; i < values.length; i++) {
    const rowName = normalizeName(values[i][1]);
    const rowMobile = normalizeMobile(values[i][2]);
    if (rowName === target && rowMobile === targetMobile) {
      return {
        email: String(values[i][0] || '').trim().toLowerCase(),
        name: String(values[i][1] || '').trim(),
        mobile: rowMobile
      };
    }
  }
  return null;
}

function findWhitelistName(name) {
  const values = getWhitelistValues();
  if (!values.length) return null;
  const target = normalizeName(name);

  for (let i = 0; i < values.length; i++) {
    if (normalizeName(values[i][1]) === target) {
      return {
        row: i + 2,
        email: String(values[i][0] || '').trim().toLowerCase(),
        name: String(values[i][1] || '').trim(),
        mobile: normalizeMobile(values[i][2])
      };
    }
  }
  return null;
}

function findWhitelistMobile(mobile) {
  const values = getWhitelistValues();
  if (!values.length) return null;
  const targetMobile = normalizeMobile(mobile);

  for (let i = 0; i < values.length; i++) {
    if (normalizeMobile(values[i][2]) === targetMobile) {
      return {
        row: i + 2,
        email: String(values[i][0] || '').trim().toLowerCase(),
        name: String(values[i][1] || '').trim(),
        mobile: targetMobile
      };
    }
  }
  return null;
}

function simpleLogin(name, mobile) {
  try {
    name = String(name || '').replace(/\s+/g, ' ').trim();
    mobile = normalizeMobile(mobile);

    if (!name) return { success: false, message: 'Please enter your name.' };
    if (name.length < 2) return { success: false, message: 'Please enter a valid name.' };
    if (!/^\d{7,15}$/.test(mobile)) {
      return { success: false, message: 'Please enter a valid mobile number using 7 to 15 digits.' };
    }

    const lock = LockService.getScriptLock();
    lock.waitLock(10000);
    try {
      const existing = findWhitelistAccount(name, mobile);
      if (existing) {
        const existingRsvp = checkExistingRSVP(name, mobile);
        return {
          success: true,
          exists: true,
          created: false,
          user: {
            name: existing.name,
            email: existing.email || existing.name,
            mobile: existing.mobile,
            method: 'name'
          },
          ticket: existingRsvp && existingRsvp.exists ? existingRsvp.ticket : null,
          message: 'Welcome back.'
        };
      }

      const existingName = findWhitelistName(name);
      if (existingName) {
        if (!existingName.mobile) {
          const whitelist = getSheet(SHEET_WHITELIST, false);
          whitelist.getRange(existingName.row, 3).setValue(mobile);
          clearBirthdayCaches();
          const existingRsvp = checkExistingRSVP(name, mobile);
          return {
            success: true,
            created: false,
            user: {
              name: existingName.name,
              email: existingName.email || existingName.name,
              mobile: mobile,
              method: 'name_mobile'
            },
            ticket: existingRsvp && existingRsvp.exists ? existingRsvp.ticket : null,
            message: 'Account updated. Welcome back.'
          };
        }

        return {
          success: false,
          message: 'Your name or mobile number does not match your existing account. Please enter the same name and mobile number you used during sign-up.'
        };
      }

      const existingMobile = findWhitelistMobile(mobile);
      if (existingMobile && normalizeName(existingMobile.name) !== normalizeName(name)) {
        return {
          success: false,
          message: 'Your name or mobile number does not match your existing account. Please enter the same name and mobile number you used during sign-up.'
        };
      }

      const whitelist = getSheet(SHEET_WHITELIST, true);
      if (whitelist.getLastRow() === 0) {
        whitelist.appendRow(['Email', 'Name', 'Mobile']);
      }
      whitelist.getRange(whitelist.getLastRow() + 1, 1, 1, 3)
        .setValues([['', name, mobile]]);
      clearBirthdayCaches();

      Logger.log('Created guest account for ' + name + '.');

      return {
        success: true,
        created: true,
        user: { name: name, email: name, mobile: mobile, method: 'name_mobile' },
        message: 'Account created. Welcome.'
      };
    } finally {
      lock.releaseLock();
    }
  } catch (e) {
    Logger.log('simpleLogin error: ' + e.toString());
    return { success: false, message: 'Unable to sign in.' };
  }
}

function loginByMobile(mobile) {
  try {
    mobile = normalizeMobile(mobile);
    if (!/^\d{7,15}$/.test(mobile)) {
      return { success: false, message: 'Please enter a valid mobile number using 7 to 15 digits.' };
    }

    const account = findWhitelistMobile(mobile);
    if (!account || !account.name) {
      return { success: false, message: 'No account was found for that mobile number.' };
    }

    const existingRsvp = checkExistingRSVP(account.name, mobile);
    return {
      success: true,
      recovered: true,
      user: {
        name: account.name,
        email: account.email || account.name,
        mobile: account.mobile,
        method: 'mobile'
      },
      ticket: existingRsvp && existingRsvp.exists ? existingRsvp.ticket : null,
      message: 'Account found. Welcome back.'
    };
  } catch (e) {
    Logger.log('loginByMobile error: ' + e.toString());
    return { success: false, message: 'Unable to recover the account.' };
  }
}

/* ============================================================
   EXISTING RSVP CHECK
   ============================================================ */
function checkExistingRSVP(nameOrEmail, mobile) {
  try {
    const target = normalizeName(nameOrEmail);
    if (!target) return { success: false, message: 'No name provided.' };

    if (!findWhitelistAccount(nameOrEmail, mobile)) {
      return {
        success: false,
        message: 'Your name or mobile number does not match your existing account. Please enter the same name and mobile number you used during sign-up.'
      };
    }

    const sh = getResponsesSheet();
    const lastRow = sh.getLastRow();
    if (lastRow < 2) return { success: true, exists: false };

    const data = sh.getRange(2, 1, lastRow - 1, RESPONSES_HEADERS.length).getValues();

    for (let i = 0; i < data.length; i++) {
      const rowEmail = String(data[i][COL.EMAIL] || '').trim().toLowerCase();
      const rowName = normalizeName(data[i][COL.NAME]);

      if ((rowName && rowName === target) || (rowEmail && rowEmail === target)) {
        const scriptUrl = ScriptApp.getService().getUrl() || '';
        const ticketCode = String(data[i][COL.TICKET_CODE] || '').trim();
        const qrData = scriptUrl
          ? scriptUrl + '?page=scan&code=' + encodeURIComponent(ticketCode)
          : ticketCode;

        return {
          success: true,
          exists: true,
          ticket: {
            code: ticketCode,
            qrCodeUrl: getQrCodeUrl(qrData, 400),
            name: String(data[i][COL.NAME] || ''),
            guests: parseInt(data[i][COL.GUESTS] || 1, 10),
            qrData: qrData,
            attendance: String(data[i][COL.ATTENDANCE] || 'going').trim().toLowerCase()
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
    const cache = CacheService.getScriptCache();
    const cached = cache.get(ATTENDEES_CACHE_KEY);
    if (cached) {
      try { return JSON.parse(cached); } catch (e) {}
    }

    const sh = getResponsesSheet();
    const lastRow = sh.getLastRow();
    if (lastRow < 2) {
      return { success: true, attendees: [], totalGuests: 0, totalParties: 0 };
    }

    const data = sh.getRange(2, 1, lastRow - 1, RESPONSES_HEADERS.length).getValues();

    const attendees = [];
    let totalGuests = 0;

    for (let i = 0; i < data.length; i++) {
      const name = String(data[i][COL.NAME] || '').trim();
      const guests = parseInt(data[i][COL.GUESTS] || 1, 10);
      const attendance = String(data[i][COL.ATTENDANCE] || 'going').trim().toLowerCase();

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

        // ⭐ Only count guests for actual attendees, not for 'not_going'
        if (attendance === 'going') {
          totalGuests += guests;
        }
      }
    }

    attendees.reverse();

    const result = {
      success: true,
      attendees: attendees,
      totalGuests: totalGuests,
      totalParties: attendees.length
    };
    try { cache.put(ATTENDEES_CACHE_KEY, JSON.stringify(result), CACHE_TTL_SECONDS); } catch (e) {}
    return result;
  } catch (e) {
    Logger.log('getAllAttendees error: ' + e.toString());
    return { success: false, message: e.toString(), attendees: [] };
  }
}

/* ============================================================
   RSVP SUBMISSION  ⭐ UPDATED
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

    const mobile = String(formData.mobile || '').trim();
    if (!mobile) return { success: false, message: 'Mobile is required.' };
    if (!/^\d{7,15}$/.test(mobile)) {
      return { success: false, message: 'Please enter a valid mobile number using numbers only.' };
    }

    if (!formData.address || !String(formData.address).trim()) return { success: false, message: 'Address is required.' };
    if (!formData.greetings || !String(formData.greetings).trim()) return { success: false, message: 'Greetings are required.' };

    const attendance = String(formData.attendance || 'going').trim().toLowerCase();
    const validAttendance = ['going', 'planning', 'not_going'];
    if (!validAttendance.includes(attendance)) {
      return { success: false, message: 'Please choose an attendance option.' };
    }

    // ⭐ CHANGED: Require selfie for going/planning, require video for not_going.
    const hasSelfie = !!(formData.selfie && formData.selfie.data);
    const hasVideo  = !!(formData.videoGreeting && formData.videoGreeting.data);

    if (attendance === 'not_going') {
      if (!hasVideo) {
        return { success: false, message: 'Please record a video greeting before submitting.' };
      }
    } else {
      if (!hasSelfie) {
        return { success: false, message: 'Selfie is required.' };
      }
    }

    // Reject invalid guests (e.g. "2abc", letters, negatives).
    const guestsText = String(formData.guests == null ? '' : formData.guests).trim();
    if (!/^\d+$/.test(guestsText)) {
      return { success: false, message: 'Please enter a valid number of guests.' };
    }
    const guests = Number(guestsText);
    if (!Number.isInteger(guests) || guests < 1 || guests > 20) {
      return { success: false, message: 'Please enter a whole number of guests from 1 to 20.' };
    }

    lock.waitLock(30000);
    try {
      const authorizedGuest = findWhitelistAccount(submittedName, mobile);
      if (!authorizedGuest) {
        return {
          success: false,
          message: 'Your name or mobile number does not match your existing account. Please enter the same name and mobile number you used during sign-up.'
        };
      }

      const duplicate = findResponseByName(submittedName);
      if (duplicate) {
        return {
          success: false,
          duplicate: true,
          message: 'This name has already submitted an RSVP. Each player may submit only once.'
        };
      }

      const sheet = getResponsesSheet();

      // ⭐ CHANGED: Upload selfie only when present; upload video when present.
      let selfieUrl = '';
      let videoUrl = '';

      if (hasSelfie) {
        const folder = getOrCreateFolder();
        selfieUrl = uploadDataUrlToDrive(
          formData.selfie.data,
          formData.selfie.name || 'selfie.jpg',
          folder
        );
      }

      if (hasVideo) {
        const videoFolder = getOrCreateVideoFolder();
        videoUrl = uploadDataUrlToDrive(
          formData.videoGreeting.data,
          formData.videoGreeting.name || 'video_greeting.webm',
          videoFolder
        );
      }

      const ticketCode = generateTicketCode();
      const identifier = String(formData.email || submittedName).trim();

      // ⭐ CHANGED: Append row including new Video Greeting URL column
      sheet.appendRow([
        new Date(),                                  // Timestamp
        submittedName,                               // Name
        mobile,                                      // Mobile
        String(formData.address).trim(),             // Address
        String(formData.greetings).trim(),           // Greetings
        selfieUrl,                                   // Selfie URL
        identifier,                                  // Email
        guests,                                      // Guests
        formData.loginMethod || 'name',              // Login Method
        ticketCode,                                  // Ticket Code
        '',                                          // Checked In
        attendance,                                  // Attendance
        videoUrl                                     // Video Greeting URL ⭐ NEW
      ]);

      const scriptUrl = ScriptApp.getService().getUrl() || '';
      const qrData = scriptUrl
        ? scriptUrl + '?page=scan&code=' + encodeURIComponent(ticketCode)
        : ticketCode;
      const qrCodeUrl = getQrCodeUrl(qrData, 400);
      clearBirthdayCaches();

      const successMessage = attendance === 'not_going'
        ? 'Thank you! We received your video greeting. 💌'
        : 'Thank you! Your attendance is confirmed. 🎉';

      return {
        success: true,
        message: successMessage,
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
   ⭐ NEW: Upload a data URL (image or video) to a Drive folder.
   Returns the public URL of the uploaded file.
   ============================================================ */
function uploadDataUrlToDrive(dataUrl, filename, folder) {
  const parts = String(dataUrl).split(',');
  if (parts.length < 2) throw new Error('Invalid media data (missing comma separator).');

  const meta = parts[0];
  const base64Data = parts[1];
  const contentTypeMatch = meta.match(/:(.*?);/);
  const contentType = contentTypeMatch ? contentTypeMatch[1] : 'application/octet-stream';

  const bytes = Utilities.base64Decode(base64Data);
  const blob = Utilities.newBlob(bytes, contentType, filename);
  const file = folder.createFile(blob);
  try {
    file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
  } catch (e) {
    Logger.log('Sharing warning: ' + e.toString());
  }
  return file.getUrl();
}

/* ============================================================
   PAYMENT CONFIRMATION
   ============================================================ */
function getPaymentsSheet() {
  const sh = getSheet(SHEET_PAYMENTS, true);
  if (!sh) throw new Error('Could not create "' + SHEET_PAYMENTS + '".');
  if (sh.getLastRow() === 0) {
    sh.getRange(1, 1, 1, PAYMENT_HEADERS.length).setValues([PAYMENT_HEADERS]);
  } else if (sh.getLastColumn() < PAYMENT_HEADERS.length) {
    sh.getRange(1, 1, 1, PAYMENT_HEADERS.length).setValues([PAYMENT_HEADERS]);
  }
  return sh;
}

function submitPayment(data) {
  const lock = LockService.getScriptLock();
  try {
    const name = String(data.name || '').replace(/\s+/g, ' ').trim();
    const mobile = normalizeMobile(data.mobile || '');
    const amountText = String(data.amount == null ? '' : data.amount).replace(/,/g, '').trim();
    const reference = String(data.reference || '').trim();
    const notes = String(data.notes || '').trim().substring(0, 500);

    if (name.length < 2) return { success: false, message: 'Please enter your name.' };
    if (!/^\d{7,15}$/.test(mobile)) return { success: false, message: 'Please enter a valid mobile number.' };
    if (!/^\d+(\.\d{1,2})?$/.test(amountText) || Number(amountText) <= 0) {
      return { success: false, message: 'Please enter a valid payment amount.' };
    }
    if (reference.length < 4 || reference.length > 100) {
      return { success: false, message: 'Please enter a valid transaction reference.' };
    }

    lock.waitLock(15000);
    try {
      const sh = getPaymentsSheet();
      const lastRow = sh.getLastRow();
      if (lastRow >= 2) {
        const references = sh.getRange(2, 5, lastRow - 1, 1).getDisplayValues().flat();
        if (references.some(function(value) { return String(value).trim().toLowerCase() === reference.toLowerCase(); })) {
          return { success: false, duplicate: true, message: 'This transaction reference has already been submitted.' };
        }
      }

      sh.appendRow([new Date(), name, mobile, Number(amountText).toFixed(2), reference, notes, 'Submitted']);
      return { success: true, message: 'Payment reference submitted. Thank you!' };
    } finally {
      lock.releaseLock();
    }
  } catch (e) {
    Logger.log('submitPayment error: ' + e.toString());
    return { success: false, message: 'Unable to submit the payment reference.' };
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

    const data = sh.getRange(2, 1, lastRow - 1, RESPONSES_HEADERS.length).getValues();

    for (let i = 0; i < data.length; i++) {
      const row = data[i];
      const rowCode = String(row[COL.TICKET_CODE] || '').trim().toUpperCase();

      if (rowCode === code) {
        const checkedInRaw = row[COL.CHECKED_IN];
        const isCheckedIn = !!checkedInRaw;

        return {
          success: true,
          valid: true,
          alreadyCheckedIn: isCheckedIn,
          checkedInAt: isCheckedIn ? String(checkedInRaw) : '',
          rowIndex: i + 2,
          guest: {
            name: String(row[COL.NAME] || ''),
            mobile: String(row[COL.MOBILE] || ''),
            email: String(row[COL.EMAIL] || ''),
            guests: parseInt(row[COL.GUESTS] || 1, 10),
            ticketCode: rowCode,
            selfieUrl: String(row[COL.SELFIE_URL] || ''),
            videoUrl: String(row[COL.VIDEO_URL] || ''),   // ⭐ NEW
            attendance: String(row[COL.ATTENDANCE] || 'going').trim().toLowerCase()
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

    const data = sh.getRange(2, 1, lastRow - 1, RESPONSES_HEADERS.length).getValues();

    for (let i = 0; i < data.length; i++) {
      const rowCode = String(data[i][COL.TICKET_CODE] || '').trim().toUpperCase();
      if (rowCode === code) {
        const rowIndex = i + 2;
        const checkedInCell = sh.getRange(rowIndex, COL.CHECKED_IN + 1);

        if (checkedInCell.getValue()) {
          return {
            success: true,
            alreadyCheckedIn: true,
            checkedInAt: String(checkedInCell.getValue()),
            guest: {
              name: String(data[i][COL.NAME] || ''),
              mobile: String(data[i][COL.MOBILE] || ''),
              email: String(data[i][COL.EMAIL] || ''),
              guests: parseInt(data[i][COL.GUESTS] || 1, 10),
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
            name: String(data[i][COL.NAME] || ''),
            mobile: String(data[i][COL.MOBILE] || ''),
            email: String(data[i][COL.EMAIL] || ''),
            guests: parseInt(data[i][COL.GUESTS] || 1, 10),
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
    whitelist.appendRow(['Email', 'Name', 'Mobile']);
    Logger.log('✓ Created "' + SHEET_WHITELIST + '"');
  } else {
    whitelist.getRange(1, 1, 1, 3).setValues([['Email', 'Name', 'Mobile']]);
    Logger.log('✓ Updated headers on "' + SHEET_WHITELIST + '"');
  }

  const folder = getOrCreateFolder();
  Logger.log('✓ Selfie Drive folder: ' + folder.getUrl());

  const videoFolder = getOrCreateVideoFolder();  // ⭐ NEW
  Logger.log('✓ Video Greeting Drive folder: ' + videoFolder.getUrl());

  Logger.log('=== Setup complete ===');
  return 'Setup complete.';
}

/**
 * ⭐ NEW: Safe migration for existing sheets.
 * Adds the "Video Greeting URL" column to the Responses sheet without
 * touching any existing data rows.
 */
function migrateResponsesForVideo() {
  const sh = getSheet(SHEET_RESPONSES, true);
  const headerRow = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0];

  // If the new column is already present, do nothing.
  if (headerRow.indexOf('Video Greeting URL') !== -1) {
    Logger.log('Header already has "Video Greeting URL". Nothing to migrate.');
    return 'Already up to date.';
  }

  const newColIndex = headerRow.length + 1;
  sh.getRange(1, newColIndex).setValue('Video Greeting URL');
  Logger.log('✓ Added "Video Greeting URL" header at column ' + newColIndex);

  // Also ensure the video folder exists
  const videoFolder = getOrCreateVideoFolder();
  Logger.log('✓ Video Greeting Drive folder ready: ' + videoFolder.getUrl());

  return 'Migration complete.';
}

function migrateWhitelistSheet() {
  const whitelist = getSheet(SHEET_WHITELIST, true);
  whitelist.getRange(1, 1, 1, 3).setValues([['Email', 'Name', 'Mobile']]);
  Logger.log('Whitelist is ready. Add each guest mobile number in column C.');
  return 'Whitelist updated. Add mobile numbers in column C.';
}

/* ============================================================
   RESET ALL DATA — Run once from the editor
   ------------------------------------------------------------
   Wipes all guest responses, whitelist entries, uploaded selfies,
   video greetings, and resets the Settings sheet to defaults.

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
    '• All files in the "Birthday Video Greetings" Drive folder\n' +
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
    videosDeleted: 0,           // ⭐ NEW
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
      whitelist.getRange(1, 1, 1, 3).setValues([['Email', 'Name', 'Mobile']]);
      Logger.log('✓ Cleared Whitelist sheet (' + summary.whitelistDeleted + ' rows).');
    }
  } catch (e) {
    Logger.log('Could not clear Whitelist: ' + e.toString());
  }

  /* -------- 3. Delete all selfie files -------- */
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

  /* -------- 4. ⭐ NEW: Delete all video greeting files -------- */
  try {
    const folders = DriveApp.getFoldersByName(VIDEO_FOLDER_NAME);
    if (folders.hasNext()) {
      const folder = folders.next();
      const files = folder.getFiles();
      while (files.hasNext()) {
        const file = files.next();
        try {
          file.setTrashed(true);
          summary.videosDeleted++;
        } catch (e) {
          Logger.log('Could not trash video ' + file.getName() + ': ' + e.toString());
        }
      }
      Logger.log('✓ Deleted ' + summary.videosDeleted + ' video file(s).');
    } else {
      Logger.log('No "' + VIDEO_FOLDER_NAME + '" folder found — nothing to delete.');
    }
  } catch (e) {
    Logger.log('Could not delete videos: ' + e.toString());
  }

  /* -------- 5. Reset the Settings sheet -------- */
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
    'Video files deleted: ' + summary.videosDeleted + '\n' +   // ⭐ NEW
    'Settings reset: ' + (summary.settingsReset ? 'yes' : 'no'),
    ui.ButtonSet.OK
  );

  return 'Reset complete.';
}
