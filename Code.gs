/**
 * Birthday Invitation — Backend
 * Handles:
 *   - Apps Script HTML service (doGet)
 *   - Vercel / GitHub Pages frontend via fetch() (doPost)
 *
 * Attendance values: 'going' | 'planning' | 'not_going'
 *
 * ⭐ UPDATED: Supports video greetings for guests who can't attend.
 * ⭐ UPDATED: getAllAttendees now returns fast, caches reliably,
 *            and never fails silently.
 */

const SHEET_RESPONSES = 'Responses';
const SHEET_WHITELIST = 'Whitelist';
const SHEET_SETTINGS  = 'Settings';
const SHEET_WALL_OF_LOVE = 'WallOfLove';
const FOLDER_NAME     = 'Birthday Selfies';
const VIDEO_FOLDER_NAME = 'Birthday Video Greetings';
const SHEET_PAYMENTS   = 'Payments';
const SHEET_LEADERBOARD = 'Leaderboard';

const LEADERBOARD_HEADERS = ['Timestamp', 'Name', 'Score'];

const WALL_OF_LOVE_HEADERS = ['Timestamp', 'Name', 'Message', 'Avatar URL', 'Hearts'];
const WALL_COL = {
  TIMESTAMP: 0,
  NAME: 1,
  MESSAGE: 2,
  AVATAR_URL: 3,
  HEARTS: 4
};

const PAYMENT_HEADERS = [
  'Timestamp', 'Name', 'Mobile', 'Amount', 'Transaction Reference', 'Notes', 'Status'
];

// Short-lived caches reduce repeated full-sheet reads while keeping new
// signups and RSVPs visible quickly after they are written.
const CACHE_TTL_SECONDS = 30;
const ADMIN_SESSION_TTL_SECONDS = 21600;
const ADMIN_SESSION_PREFIX = 'birthday_admin_session_';
const RATE_LIMIT_PREFIX = 'birthday_rate_limit_';
const RATE_LIMIT_WINDOW_SECONDS = 300;
const WHITELIST_CACHE_KEY = 'birthday_whitelist_v1';
const ATTENDEES_CACHE_KEY = 'birthday_attendees_v1';
const WALL_CACHE_KEY = 'birthday_wall_of_love_v2';
const SETTINGS_CACHE_KEY = 'birthday_settings_v1';
const LEADERBOARD_CACHE_KEY = 'birthday_leaderboard_v1';

// ⭐ CHANGED: Added "Video Greeting URL" column.
const RESPONSES_HEADERS = [
  'Timestamp', 'Name', 'Mobile', 'Address', 'Greetings',
  'Selfie URL', 'Email', 'Guests', 'Login Method',
  'Ticket Code', 'Checked In', 'Attendance', 'Video Greeting URL',
  'Wall of Love Hearts'
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
  VIDEO_URL:    12,
  WALL_HEARTS:  13
};

/* ============================================================
   WEB APP ENTRY (GET)
   ============================================================ */
function rateLimitKey(action, identifier) {
  const digest = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, String(action) + '|' + String(identifier), Utilities.Charset.UTF_8);
  return RATE_LIMIT_PREFIX + digest.map(function(byte) { const n = byte < 0 ? byte + 256 : byte; return ('0' + n.toString(16)).slice(-2); }).join('');
}
function allowRateLimit(action, identifier, maxAttempts, ttlSeconds) {
  try {
    const cache = CacheService.getScriptCache();
    const key = rateLimitKey(action, identifier);
    const current = Number(cache.get(key) || 0);
    if (current >= maxAttempts) return false;
    cache.put(key, String(current + 1), ttlSeconds || RATE_LIMIT_WINDOW_SECONDS);
    return true;
  } catch (e) {
    // A cache outage should not make the public site unavailable.
    return true;
  }
}
function genericLoginFailure() {
  return 'The details could not be verified. Please check your information and try again.';
}

function doGet(e) {
  if (e && e.parameter && e.parameter.action) {
    return handleApiRequest(e);
  }

  const page = (e && e.parameter && e.parameter.page) || 'index';

  if (page === 'scan') {
    return HtmlService.createHtmlOutputFromFile('Scanner')
      .setTitle('Admin • Check-In Scanner')
      .addMetaTag('viewport', 'width=device-width, initial-scale=1, viewport-fit=cover')
      .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.DEFAULT);
  }

  return HtmlService.createHtmlOutputFromFile('Index')
    .setTitle('Simon Jabeguero')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1, viewport-fit=cover')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.DEFAULT);
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

  if (e && e.parameter) {
    Object.keys(e.parameter).forEach(function(k) {
      params[k] = e.parameter[k];
    });
  }

  if (e && e.postData && e.postData.contents) {
    const body = e.postData.contents;

    try {
      const parsed = JSON.parse(body);
      if (parsed && parsed.action) {
        Object.keys(parsed).forEach(function(k) {
          params[k] = parsed[k];
        });
        return params;
      }
    } catch (err) { /* not JSON — fall through */ }

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
    if (action === 'verifyTicket')    return jsonResponse(verifyTicket(params.code || '', params.token || ''));
    if (action === 'checkInTicket')   return jsonResponse(checkInTicket(params.code || '', params.token || ''));

    if (action === 'checkExistingRSVP') {
      return jsonResponse(checkExistingRSVP(
        params.name || params.email || '',
        params.mobile || ''
      ));
    }

    if (action === 'getAllAttendees') return jsonResponse(getAllAttendees(params.force === true || params.force === 'true'));
    if (action === 'getWallOfLove') return jsonResponse(getWallOfLove());
    if (action === 'getWallOfLoveStatus') return jsonResponse(getWallOfLoveStatus(params.name || ''));
    if (action === 'submitWallOfLove') {
      let wallData = {};
      try { wallData = JSON.parse(params.data || '{}'); }
      catch (err) { return jsonResponse({ success: false, message: 'Invalid Wall of Love data.' }); }
      return jsonResponse(submitWallOfLove(wallData));
    }
    if (action === 'reactToWallOfLove') return jsonResponse(reactToWallOfLove(params.rowIndex, params.delta, params.source || 'responses'));
    if (action === 'getLeaderboard') return jsonResponse(getLeaderboard(params.force === true || params.force === 'true'));
    if (action === 'saveLeaderboardScore') return jsonResponse(saveLeaderboardScore(params.name || '', params.score));
    if (action === 'getAdminLeaderboard') return jsonResponse(getAdminLeaderboard(params.token || ''));
    if (action === 'updateLeaderboardScore') {
      let leaderboardData = {};
      try { leaderboardData = JSON.parse(params.data || '{}'); }
      catch (err) { return jsonResponse({ success: false, message: 'Invalid leaderboard data.' }); }
      return jsonResponse(updateLeaderboardScore(leaderboardData, params.token || ''));
    }
    if (action === 'deleteLeaderboardScore') return jsonResponse(deleteLeaderboardScore(params.rowIndex || '', params.token || ''));
    if (action === 'resetLeaderboard') return jsonResponse(resetLeaderboard(params.token || ''));
    if (action === 'getAdminAttendees') return jsonResponse(getAdminAttendees(params.token || ''));
    if (action === 'getAdminWallOfLove') return jsonResponse(getAdminWallOfLove(params.token || ''));
    if (action === 'deleteWallOfLove') return jsonResponse(deleteWallOfLove(params.rowIndex || '', params.token || '', params.source || 'wall'));
    if (action === 'updateWallOfLove') {
      let wallUpdateData = {};
      try { wallUpdateData = JSON.parse(params.data || '{}'); }
      catch (err) { return jsonResponse({ success: false, message: 'Invalid Wall of Love data.' }); }
      return jsonResponse(updateWallOfLove(wallUpdateData, params.token || ''));
    }
    if (action === 'updateAttendee') {
      let attendeeData = {};
      try { attendeeData = JSON.parse(params.data || '{}'); }
      catch (err) { return jsonResponse({ success: false, message: 'Invalid attendee data.' }); }
      return jsonResponse(updateAttendee(attendeeData, params.token || ''));
    }
    if (action === 'deleteAttendee') return jsonResponse(deleteAttendee(params.rowIndex || '', params.token || ''));

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
    return jsonResponse({ success: false, message: 'The request could not be completed. Please try again.' });
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
    const headerNeedsUpdate = RESPONSES_HEADERS.some(function(header, index) {
      return String(headerRow[index] || '').trim() !== header;
    });
    if (headerNeedsUpdate) {
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
      SETTINGS_CACHE_KEY,
      LEADERBOARD_CACHE_KEY,
      WALL_CACHE_KEY
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

function getOrCreateVideoFolder() {
  const folders = DriveApp.getFoldersByName(VIDEO_FOLDER_NAME);
  return folders.hasNext() ? folders.next() : DriveApp.createFolder(VIDEO_FOLDER_NAME);
}

function getWallOfLoveSheet() {
  const sh = getSheet(SHEET_WALL_OF_LOVE, true);
  if (!sh) throw new Error('Could not create \"' + SHEET_WALL_OF_LOVE + '\".');
  if (sh.getLastRow() === 0) {
    sh.getRange(1, 1, 1, WALL_OF_LOVE_HEADERS.length).setValues([WALL_OF_LOVE_HEADERS]);
  } else {
    sh.getRange(1, 1, 1, WALL_OF_LOVE_HEADERS.length).setValues([WALL_OF_LOVE_HEADERS]);
  }
  return sh;
}

function normalizeName(value) {
  return String(value || '').replace(/\s+/g, ' ').trim().toLowerCase();
}

function normalizeMobile(value) {
  let digits = String(value || '').replace(/\D/g, '').trim();
  if (digits.indexOf('63') === 0 && digits.length === 12) {
    digits = '0' + digits.substring(2);
  } else if (digits.length === 10 && digits.indexOf('9') === 0) {
    digits = '0' + digits;
  }
  return digits;
}

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
    if (!allowRateLimit('simpleLogin', normalizeName(name) + '|' + mobile, 8)) return { success: false, message: genericLoginFailure() };

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
    if (!allowRateLimit('loginByMobile', mobile, 5)) return { success: false, message: genericLoginFailure() };

    const account = findWhitelistMobile(mobile);
    if (!account || !account.name) {
      return { success: false, message: genericLoginFailure() };
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
   ⭐ GET ALL ATTENDEES — fast, reliable, never fails silently
   ============================================================ */
function getAllAttendees(forceRefresh) {
  try {
    const cache = CacheService.getScriptCache();

    // 1. Try cache first — return immediately if hit
    if (!forceRefresh) {
      try {
        const cached = cache.get(ATTENDEES_CACHE_KEY);
        if (cached) {
          const parsed = JSON.parse(cached);
          if (parsed && parsed.success) {
            Logger.log('getAllAttendees: cache hit');
            return parsed;
          }
        }
      } catch (cacheErr) {
        Logger.log('getAllAttendees: cache read failed — ' + cacheErr.toString());
      }
    }

    // 2. Get the sheet
    const sh = getSheet(SHEET_RESPONSES, false);
    if (!sh) {
      Logger.log('getAllAttendees: Responses sheet not found');
      return { success: false, attendees: [], message: 'The Responses sheet was not found.' };
    }

    const lastRow = sh.getLastRow();
    if (lastRow < 2) {
      const empty = { success: true, attendees: [], totalGuests: 0, totalParties: 0 };
      try { cache.put(ATTENDEES_CACHE_KEY, JSON.stringify(empty), CACHE_TTL_SECONDS); } catch (e) {}
      return empty;
    }

    // 3. Read only what we need — name, guests, attendance columns
    //    This is much faster than reading all 13 columns.
    const nameCol = COL.NAME + 1;             // 1-based
    const guestsCol = COL.GUESTS + 1;
    const attendanceCol = COL.ATTENDANCE + 1;

    const nameRange = sh.getRange(2, nameCol, lastRow - 1, 1).getValues();
    const guestsRange = sh.getRange(2, guestsCol, lastRow - 1, 1).getValues();
    const attendanceRange = sh.getRange(2, attendanceCol, lastRow - 1, 1).getValues();

    const attendees = [];
    let totalGuests = 0;

    for (let i = 0; i < nameRange.length; i++) {
      const rawName = String(nameRange[i][0] || '').trim();
      if (!rawName) continue;

      const guests = parseInt(guestsRange[i][0] || 1, 10) || 1;
      const attendance = String(attendanceRange[i][0] || 'going').trim().toLowerCase();

      // Shorten to "First L." format for privacy
      const nameParts = rawName.split(/\s+/);
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

    // Newest responses first
    attendees.reverse();

    const result = {
      success: true,
      attendees: attendees,
      totalGuests: totalGuests,
      totalParties: attendees.length
    };

    // 4. Cache the result (best-effort — don't fail if it doesn't stick)
    try {
      cache.put(ATTENDEES_CACHE_KEY, JSON.stringify(result), CACHE_TTL_SECONDS);
      Logger.log('getAllAttendees: cached ' + attendees.length + ' attendees');
    } catch (cacheErr) {
      Logger.log('getAllAttendees: cache write failed — ' + cacheErr.toString());
    }

    return result;

  } catch (e) {
    Logger.log('getAllAttendees error: ' + e.toString());
    return {
      success: false,
      attendees: [],
      message: 'Could not load attendee responses. Please try again.'
    };
  }
}

/* ============================================================
   SHARED MINI-GAME LEADERBOARD
   ============================================================ */
function getLeaderboardSheet() {
  const sh = getSheet(SHEET_LEADERBOARD, true);
  if (!sh) throw new Error('Could not create "' + SHEET_LEADERBOARD + '".');
  if (sh.getLastRow() === 0) {
    sh.getRange(1, 1, 1, LEADERBOARD_HEADERS.length).setValues([LEADERBOARD_HEADERS]);
  } else if (sh.getLastColumn() < LEADERBOARD_HEADERS.length) {
    sh.getRange(1, 1, 1, LEADERBOARD_HEADERS.length).setValues([LEADERBOARD_HEADERS]);
  }
  return sh;
}

function getLeaderboard(forceRefresh) {
  const cache = CacheService.getScriptCache();
  if (!forceRefresh) {
    const cached = cache.get(LEADERBOARD_CACHE_KEY);
    if (cached) {
      try { return JSON.parse(cached); } catch (e) {}
    }
  }

  const sh = getLeaderboardSheet();
  const lastRow = sh.getLastRow();
  const entries = [];
  if (lastRow >= 2) {
    const values = sh.getRange(2, 1, lastRow - 1, LEADERBOARD_HEADERS.length).getValues();
    values.forEach(function(row) {
      const name = String(row[1] || '').replace(/\s+/g, ' ').trim();
      const score = Number(row[2]);
      if (name && Number.isFinite(score) && score > 0) {
        entries.push({ name: name, score: Math.floor(score), date: row[0] || '' });
      }
    });
  }
  entries.sort(function(a, b) {
    return b.score - a.score || String(a.name).localeCompare(String(b.name));
  });
  const result = { success: true, entries: entries.slice(0, 50) };
  try { cache.put(LEADERBOARD_CACHE_KEY, JSON.stringify(result), CACHE_TTL_SECONDS); } catch (e) {}
  return result;
}

function saveLeaderboardScore(nameValue, scoreValue) {
  const name = String(nameValue || '').replace(/\s+/g, ' ').trim();
  const score = Number(scoreValue);
  if (!name || name.length < 2 || name.length > 100) {
    return { success: false, message: 'A valid player name is required.' };
  }
  if (!Number.isFinite(score) || !Number.isInteger(score) || score <= 0 || score > 1000) {
    return { success: false, message: 'Invalid score.' };
  }

  const lock = LockService.getScriptLock();
  try {
    lock.waitLock(10000);
    const sh = getLeaderboardSheet();
    const lastRow = sh.getLastRow();
    let matchingRow = 0;
    if (lastRow >= 2) {
      const names = sh.getRange(2, 2, lastRow - 1, 1).getValues();
      const target = normalizeName(name);
      for (let i = 0; i < names.length; i++) {
        if (normalizeName(names[i][0]) === target) {
          matchingRow = i + 2;
          break;
        }
      }
    }

    if (matchingRow) {
      const existingScore = Number(sh.getRange(matchingRow, 3).getValue()) || 0;
      if (score > existingScore) {
        sh.getRange(matchingRow, 1, 1, 3).setValues([[new Date(), name, score]]);
      }
    } else {
      sh.appendRow([new Date(), name, score]);
    }
    try { cacheRemoveLeaderboard(); } catch (e) {}
    return { success: true, message: 'Score saved.' };
  } catch (e) {
    Logger.log('saveLeaderboardScore error: ' + e.toString());
    return { success: false, message: 'Could not save score: ' + e.toString() };
  } finally {
    try { lock.releaseLock(); } catch (e) {}
  }
}

function cacheRemoveLeaderboard() {
  CacheService.getScriptCache().remove(LEADERBOARD_CACHE_KEY);
}

function cacheRemoveWallOfLove() {
  try { CacheService.getScriptCache().remove(WALL_CACHE_KEY); } catch (e) {}
}

function getWallOfLove() {
  try {
    const cached = CacheService.getScriptCache().get(WALL_CACHE_KEY);
    if (cached) {
      try { return JSON.parse(cached); } catch (cacheError) { cacheRemoveWallOfLove(); }
    }
    const messages = [];
    const responses = getResponsesSheet();
    if (responses.getLastRow() >= 2) {
      const firstRow = Math.max(2, responses.getLastRow() - 99);
      const rows = responses.getRange(firstRow, 1, responses.getLastRow() - firstRow + 1, RESPONSES_HEADERS.length).getValues();
      rows.forEach(function(row, offset) {
        const message = String(row[COL.GREETINGS] || '').trim();
        if (!message) return;
        messages.push({
          source: 'responses', rowIndex: firstRow + offset,
          timestamp: row[COL.TIMESTAMP] instanceof Date ? row[COL.TIMESTAMP].getTime() : 0,
          name: String(row[COL.NAME] || '').trim() || 'Guest', message: message,
          hearts: Math.max(0, Number(row[COL.WALL_HEARTS]) || 0)
        });
      });
    }

    const wall = getWallOfLoveSheet();
    if (wall.getLastRow() >= 2) {
      const firstRow = Math.max(2, wall.getLastRow() - 99);
      const rows = wall.getRange(firstRow, 1, wall.getLastRow() - firstRow + 1, WALL_OF_LOVE_HEADERS.length).getValues();
      rows.forEach(function(row, offset) {
        const message = String(row[WALL_COL.MESSAGE] || '').trim();
        if (!message) return;
        messages.push({
          source: 'wall', rowIndex: firstRow + offset,
          timestamp: row[WALL_COL.TIMESTAMP] instanceof Date ? row[WALL_COL.TIMESTAMP].getTime() : 0,
          name: String(row[WALL_COL.NAME] || '').trim() || 'Guest', message: message,
          hearts: Math.max(0, Number(row[WALL_COL.HEARTS]) || 0)
        });
      });
    }
    messages.sort(function(a, b) { return (b.timestamp || 0) - (a.timestamp || 0); });
    const result = { success: true, messages: messages.slice(0, 100) };
    try { CacheService.getScriptCache().put(WALL_CACHE_KEY, JSON.stringify(result), 20); } catch (cacheError) {}
    return result;
  } catch (e) {
    Logger.log('getWallOfLove error: ' + e.toString());
    return { success: false, messages: [], message: 'Could not load greetings. Please try again.' };
  }
}

function getWallOfLoveStatus(nameValue) {
  try {
    const target = normalizeName(nameValue);
    if (!target) return { success: true, exists: false };
    const sh = getWallOfLoveSheet();
    if (sh.getLastRow() < 2) return { success: true, exists: false };
    const names = sh.getRange(2, WALL_COL.NAME + 1, sh.getLastRow() - 1, 1).getValues();
    for (let i = 0; i < names.length; i++) {
      if (normalizeName(names[i][0]) === target) return { success: true, exists: true };
    }
    return { success: true, exists: false };
  } catch (e) {
    Logger.log('getWallOfLoveStatus error: ' + e.toString());
    return { success: false, exists: false, message: 'Could not check Wall of Love status.' };
  }
}

function submitWallOfLove(data) {
  const lock = LockService.getScriptLock();
  try {
    data = data || {};
    const name = String(data.name || '').replace(/\s+/g, ' ').trim();
    const message = String(data.message || '').trim();
    if (name.length < 2 || name.length > 80) return { success: false, message: 'Please enter a name from 2 to 80 characters.' };
    if (!message || message.length > 500) return { success: false, message: 'Please enter a message up to 500 characters.' };
    if (!allowRateLimit('submitWallOfLove', normalizeName(name) + '|' + message, 4)) return { success: false, message: 'Please wait a few minutes before posting again.' };
    lock.waitLock(30000);
    const sh = getWallOfLoveSheet();
    sh.appendRow([new Date(), name, message, '', 0]);
    cacheRemoveWallOfLove();
    return { success: true, message: 'Your message is now on the Wall of Love.' };
  } catch (e) {
    Logger.log('submitWallOfLove error: ' + e.toString());
    return { success: false, message: 'Could not publish your message. Please try again.' };
  } finally {
    try { lock.releaseLock(); } catch (e) {}
  }
}

function reactToWallOfLove(rowIndex, requestedDelta, source) {
  const lock = LockService.getScriptLock();
  try {
    lock.waitLock(10000);
    const isWall = String(source || 'responses') === 'wall';
    const sh = isWall ? getWallOfLoveSheet() : getResponsesSheet();
    const targetRow = Number(rowIndex);
    if (!Number.isInteger(targetRow) || targetRow < 2 || targetRow > sh.getLastRow()) return { success: false, message: 'That message is no longer available.' };
    const messageCol = isWall ? WALL_COL.MESSAGE + 1 : COL.GREETINGS + 1;
    const heartsCol = isWall ? WALL_COL.HEARTS + 1 : COL.WALL_HEARTS + 1;
    if (!String(sh.getRange(targetRow, messageCol).getValue() || '').trim()) return { success: false, message: 'That message is no longer available.' };
    const delta = Number(requestedDelta) === -1 ? -1 : 1;
    const heartsCell = sh.getRange(targetRow, heartsCol);
    const hearts = Math.max(0, (Number(heartsCell.getValue()) || 0) + delta);
    heartsCell.setValue(hearts);
    if (isWall) cacheRemoveWallOfLove();
    SpreadsheetApp.flush();
    return { success: true, rowIndex: targetRow, source: source || 'responses', hearts: hearts };
  } catch (e) {
    Logger.log('reactToWallOfLove error: ' + e.toString());
    return { success: false, message: 'Could not save the heart reaction. Please try again.' };
  } finally {
    try { lock.releaseLock(); } catch (e) {}
  }
}

/* ============================================================
   ADMIN ATTENDEE MANAGEMENT
   ============================================================ */
function serializeAdminCell(value) {
  if (value instanceof Date) return value.toISOString();
  return value == null ? '' : String(value);
}

function adminAttendeeFromRow(row, rowIndex) {
  return {
    rowIndex: rowIndex,
    timestamp: serializeAdminCell(row[COL.TIMESTAMP]),
    name: serializeAdminCell(row[COL.NAME]),
    mobile: serializeAdminCell(row[COL.MOBILE]),
    address: serializeAdminCell(row[COL.ADDRESS]),
    greetings: serializeAdminCell(row[COL.GREETINGS]),
    selfieUrl: serializeAdminCell(row[COL.SELFIE_URL]),
    email: serializeAdminCell(row[COL.EMAIL]),
    guests: parseInt(row[COL.GUESTS] || 1, 10) || 1,
    loginMethod: serializeAdminCell(row[COL.LOGIN_METHOD]),
    ticketCode: serializeAdminCell(row[COL.TICKET_CODE]).toUpperCase(),
    checkedIn: serializeAdminCell(row[COL.CHECKED_IN]),
    attendance: serializeAdminCell(row[COL.ATTENDANCE] || 'going').toLowerCase(),
    videoUrl: serializeAdminCell(row[COL.VIDEO_URL])
  };
}

function getAdminLeaderboard(token) {
  if (!isAdminSessionValid(token)) return { success: false, message: 'Admin session expired. Please sign in again.' };
  try {
    const sh = ss().getSheetByName(SHEET_LEADERBOARD);
    if (!sh || sh.getLastRow() < 2) return { success: true, entries: [] };
    const rows = sh.getRange(2, 1, sh.getLastRow() - 1, LEADERBOARD_HEADERS.length).getValues();
    const entries = rows.map(function(row, index) {
      return { rowIndex: index + 2, date: row[0] || '', name: String(row[1] || ''), score: Number(row[2]) || 0 };
    }).filter(function(entry) { return entry.name; });
    entries.sort(function(a, b) { return b.score - a.score || a.name.localeCompare(b.name); });
    return { success: true, entries: entries };
  } catch (e) {
    Logger.log('getAdminLeaderboard error: ' + e.toString());
    return { success: false, message: 'Could not load leaderboard scores.' };
  }
}
function updateLeaderboardScore(data, token) {
  if (!isAdminSessionValid(token)) return { success: false, message: 'Admin session expired. Please sign in again.' };
  try {
    const rowIndex = Number(data && data.rowIndex);
    const name = String(data && data.name || '').replace(/\s+/g, ' ').trim();
    const score = Number(data && data.score);
    if (!Number.isInteger(rowIndex) || rowIndex < 2) return { success: false, message: 'Invalid leaderboard row.' };
    if (!name || name.length > 100) return { success: false, message: 'Please enter a valid player name.' };
    if (!Number.isInteger(score) || score < 0 || score > 1000) return { success: false, message: 'Score must be a whole number from 0 to 1000.' };
    const sh = ss().getSheetByName(SHEET_LEADERBOARD);
    if (!sh || rowIndex > sh.getLastRow()) return { success: false, message: 'Leaderboard row not found.' };
    sh.getRange(rowIndex, 1, 1, 3).setValues([[new Date(), name, score]]);
    cacheRemoveLeaderboard();
    return { success: true, message: 'Leaderboard score updated.' };
  } catch (e) {
    Logger.log('updateLeaderboardScore error: ' + e.toString());
    return { success: false, message: 'Could not update leaderboard score.' };
  }
}
function deleteLeaderboardScore(rowIndexValue, token) {
  if (!isAdminSessionValid(token)) return { success: false, message: 'Admin session expired. Please sign in again.' };
  try {
    const rowIndex = Number(rowIndexValue);
    const sh = ss().getSheetByName(SHEET_LEADERBOARD);
    if (!sh || !Number.isInteger(rowIndex) || rowIndex < 2 || rowIndex > sh.getLastRow()) return { success: false, message: 'Leaderboard row not found.' };
    sh.deleteRow(rowIndex);
    cacheRemoveLeaderboard();
    return { success: true, message: 'Leaderboard score removed.' };
  } catch (e) {
    Logger.log('deleteLeaderboardScore error: ' + e.toString());
    return { success: false, message: 'Could not remove leaderboard score.' };
  }
}
function resetLeaderboard(token) {
  if (!isAdminSessionValid(token)) return { success: false, message: 'Admin session expired. Please sign in again.' };
  try {
    const sh = ss().getSheetByName(SHEET_LEADERBOARD);
    let deleted = 0;
    if (sh && sh.getLastRow() > 1) {
      deleted = sh.getLastRow() - 1;
      sh.deleteRows(2, deleted);
      sh.getRange(1, 1, 1, LEADERBOARD_HEADERS.length).setValues([LEADERBOARD_HEADERS]);
    }
    cacheRemoveLeaderboard();
    return { success: true, deleted: deleted, message: 'Leaderboard reset.' };
  } catch (e) {
    Logger.log('resetLeaderboard error: ' + e.toString());
    return { success: false, message: 'Could not reset leaderboard.' };
  }
}

function getAdminAttendees(token) {
  if (!isAdminSessionValid(token)) {
    return { success: false, attendees: [], message: 'Admin session expired. Please sign in again.' };
  }

  try {
    const sh = getSheet(SHEET_RESPONSES, false);
    if (!sh || sh.getLastRow() < 2) {
      return { success: true, attendees: [], totalGuests: 0, totalParties: 0 };
    }
    const count = sh.getLastRow() - 1;
    const data = sh.getRange(2, 1, count, RESPONSES_HEADERS.length).getValues();
    const attendees = [];
    let totalGuests = 0;
    data.forEach(function(row, index) {
      if (!String(row[COL.NAME] || '').trim()) return;
      const attendee = adminAttendeeFromRow(row, index + 2);
      attendees.push(attendee);
      if (attendee.attendance === 'going') totalGuests += attendee.guests;
    });
    attendees.reverse();
    return {
      success: true,
      attendees: attendees,
      totalGuests: totalGuests,
      totalParties: attendees.length,
      fetchedAt: new Date().toISOString()
    };
  } catch (e) {
    Logger.log('getAdminAttendees error: ' + e.toString());
    return { success: false, attendees: [], message: 'Could not load attendees: ' + e.toString() };
  }
}

function getAdminWallOfLove(token) {
  if (!isAdminSessionValid(token)) return { success: false, messages: [], message: 'Admin session expired. Please sign in again.' };
  try {
    const messages = [];
    const wall = getWallOfLoveSheet();
    if (wall.getLastRow() >= 2) {
      const rows = wall.getRange(2, 1, wall.getLastRow() - 1, WALL_OF_LOVE_HEADERS.length).getValues();
      rows.forEach(function(row, index) {
        const name = serializeAdminCell(row[WALL_COL.NAME]);
        const message = serializeAdminCell(row[WALL_COL.MESSAGE]);
        if (!name && !message) return;
        messages.push({ source: 'wall', rowIndex: index + 2, timestamp: serializeAdminCell(row[WALL_COL.TIMESTAMP]), name: name, message: message, hearts: Math.max(0, Number(row[WALL_COL.HEARTS]) || 0) });
      });
    }
    const responses = getSheet(SHEET_RESPONSES, false);
    if (responses && responses.getLastRow() >= 2) {
      const rows = responses.getRange(2, 1, responses.getLastRow() - 1, RESPONSES_HEADERS.length).getValues();
      rows.forEach(function(row, index) {
        const message = String(row[COL.GREETINGS] || '').trim();
        if (!message) return;
        messages.push({ source: 'responses', rowIndex: index + 2, timestamp: serializeAdminCell(row[COL.TIMESTAMP]), name: serializeAdminCell(row[COL.NAME]) || 'Guest', message: message, hearts: Math.max(0, Number(row[COL.WALL_HEARTS]) || 0) });
      });
    }
    messages.sort(function(a, b) { return String(b.timestamp || '').localeCompare(String(a.timestamp || '')); });
    return { success: true, messages: messages, fetchedAt: new Date().toISOString() };
  } catch (e) {
    Logger.log('getAdminWallOfLove error: ' + e.toString());
    return { success: false, messages: [], message: 'Could not load Wall of Love messages.' };
  }
}
function updateWallOfLove(data, token) {
  if (!isAdminSessionValid(token)) return { success: false, message: 'Admin session expired. Please sign in again.' };
  const lock = LockService.getScriptLock();
  try {
    data = data || {};
    const rowIndex = Number(data.rowIndex);
    const source = String(data.source || 'wall') === 'responses' ? 'responses' : 'wall';
    const name = String(data.name || '').replace(/\s+/g, ' ').trim();
    const message = String(data.message || '').trim();
    if (!Number.isInteger(rowIndex) || rowIndex < 2) return { success: false, message: 'Invalid Wall of Love row.' };
    if (name.length < 2 || name.length > 80) return { success: false, message: 'Name must be between 2 and 80 characters.' };
    if (!message || message.length > 500) return { success: false, message: 'Message must be between 1 and 500 characters.' };
    lock.waitLock(10000);
    const sh = source === 'responses' ? getSheet(SHEET_RESPONSES, false) : getWallOfLoveSheet();
    if (!sh || rowIndex > sh.getLastRow()) return { success: false, message: 'The message no longer exists.' };
    if (source === 'responses') {
      const existing = sh.getRange(rowIndex, 1, 1, RESPONSES_HEADERS.length).getValues()[0];
      if (!String(existing[COL.GREETINGS] || '').trim()) return { success: false, message: 'The response greeting no longer exists.' };
      sh.getRange(rowIndex, COL.GREETINGS + 1).setValue(message);
      clearBirthdayCaches();
      return { success: true, message: 'Response greeting updated.' };
    }
    const existing = sh.getRange(rowIndex, 1, 1, WALL_OF_LOVE_HEADERS.length).getValues()[0];
    if (!String(existing[WALL_COL.NAME] || '').trim() && !String(existing[WALL_COL.MESSAGE] || '').trim()) return { success: false, message: 'Wall of Love message no longer exists.' };
    sh.getRange(rowIndex, WALL_COL.NAME + 1).setValue(name);
    sh.getRange(rowIndex, WALL_COL.MESSAGE + 1).setValue(message);
    cacheRemoveWallOfLove();
    return { success: true, message: 'Wall of Love message updated.' };
  } catch (e) {
    Logger.log('updateWallOfLove error: ' + e.toString());
    return { success: false, message: 'Could not update Wall of Love message.' };
  } finally {
    try { lock.releaseLock(); } catch (e) {}
  }
}
function deleteWallOfLove(rowIndexValue, token, sourceValue) {
  if (!isAdminSessionValid(token)) return { success: false, message: 'Admin session expired. Please sign in again.' };
  const lock = LockService.getScriptLock();
  try {
    const rowIndex = Number(rowIndexValue);
    const source = String(sourceValue || 'wall') === 'responses' ? 'responses' : 'wall';
    if (!Number.isInteger(rowIndex) || rowIndex < 2) return { success: false, message: 'Invalid message row.' };
    lock.waitLock(10000);
    const sh = source === 'responses' ? getSheet(SHEET_RESPONSES, false) : getWallOfLoveSheet();
    if (source === 'responses') {
      if (!sh || rowIndex > sh.getLastRow()) return { success: false, message: 'Response no longer exists.' };
      const greeting = String(sh.getRange(rowIndex, COL.GREETINGS + 1).getValue() || '').trim();
      if (!greeting) return { success: false, message: 'Response greeting no longer exists.' };
      sh.getRange(rowIndex, COL.GREETINGS + 1).clearContent();
      clearBirthdayCaches();
      return { success: true, message: 'Response greeting removed.' };
    }
    if (rowIndex > sh.getLastRow()) return { success: false, message: 'Wall of Love message no longer exists.' };
    const name = String(sh.getRange(rowIndex, WALL_COL.NAME + 1).getValue() || '').trim();
    const message = String(sh.getRange(rowIndex, WALL_COL.MESSAGE + 1).getValue() || '').trim();
    if (!name && !message) return { success: false, message: 'Wall of Love message no longer exists.' };
    sh.deleteRow(rowIndex);
    cacheRemoveWallOfLove();
    return { success: true, message: 'Wall of Love message deleted.' };
  } catch (e) {
    Logger.log('deleteWallOfLove error: ' + e.toString());
    return { success: false, message: 'Could not delete Wall of Love message.' };
  } finally {
    try { lock.releaseLock(); } catch (e) {}
  }
}
function updateAttendee(attendeeData, token) {
  if (!isAdminSessionValid(token)) {
    return { success: false, message: 'Admin session expired. Please sign in again.' };
  }

  const lock = LockService.getScriptLock();
  try {
    attendeeData = attendeeData || {};
    const rowIndex = Number(attendeeData.rowIndex);
    if (!Number.isInteger(rowIndex) || rowIndex < 2) {
      return { success: false, message: 'Invalid attendee row.' };
    }
    const name = String(attendeeData.name || '').replace(/\s+/g, ' ').trim();
    const mobile = String(attendeeData.mobile || '').trim();
    const email = String(attendeeData.email || '').trim();
    const address = String(attendeeData.address || '').trim();
    const greetings = String(attendeeData.greetings || '').trim();
    const guests = Number(attendeeData.guests);
    const attendance = String(attendeeData.attendance || 'going').trim().toLowerCase();
    if (!name) return { success: false, message: 'Name is required.' };
    if (!/^\d{7,15}$/.test(mobile.replace(/\D/g, ''))) return { success: false, message: 'Enter a valid mobile number.' };
    if (!Number.isInteger(guests) || guests < 1 || guests > 20) return { success: false, message: 'Guests must be a whole number from 1 to 20.' };
    if (['going', 'planning', 'not_going'].indexOf(attendance) === -1) return { success: false, message: 'Invalid attendance status.' };
    lock.waitLock(10000);
    const sh = getResponsesSheet();
    if (rowIndex > sh.getLastRow()) return { success: false, message: 'Attendee no longer exists.' };
    const existing = sh.getRange(rowIndex, 1, 1, RESPONSES_HEADERS.length).getValues()[0];
    if (!String(existing[COL.NAME] || '').trim()) return { success: false, message: 'Attendee no longer exists.' };
    sh.getRange(rowIndex, COL.NAME + 1, 1, 1).setValue(name);
    sh.getRange(rowIndex, COL.MOBILE + 1, 1, 1).setValue(mobile);
    sh.getRange(rowIndex, COL.ADDRESS + 1, 1, 1).setValue(address);
    sh.getRange(rowIndex, COL.GREETINGS + 1, 1, 1).setValue(greetings);
    sh.getRange(rowIndex, COL.EMAIL + 1, 1, 1).setValue(email);
    sh.getRange(rowIndex, COL.GUESTS + 1, 1, 1).setValue(guests);
    sh.getRange(rowIndex, COL.ATTENDANCE + 1, 1, 1).setValue(attendance);
    clearBirthdayCaches();
    const updated = sh.getRange(rowIndex, 1, 1, RESPONSES_HEADERS.length).getValues()[0];
    return { success: true, attendee: adminAttendeeFromRow(updated, rowIndex), message: 'Attendee updated.' };
  } catch (e) {
    Logger.log('updateAttendee error: ' + e.toString());
    return { success: false, message: 'Could not update attendee: ' + e.toString() };
  } finally {
    try { lock.releaseLock(); } catch (e) {}
  }
}

function deleteAttendee(rowIndexValue, token) {
  if (!isAdminSessionValid(token)) {
    return { success: false, message: 'Admin session expired. Please sign in again.' };
  }

  const lock = LockService.getScriptLock();
  try {
    const rowIndex = Number(rowIndexValue);
    if (!Number.isInteger(rowIndex) || rowIndex < 2) return { success: false, message: 'Invalid attendee row.' };
    lock.waitLock(10000);
    const sh = getResponsesSheet();
    if (rowIndex > sh.getLastRow()) return { success: false, message: 'Attendee no longer exists.' };
    const name = String(sh.getRange(rowIndex, COL.NAME + 1).getValue() || '').trim();
    if (!name) return { success: false, message: 'Attendee no longer exists.' };
    sh.deleteRow(rowIndex);
    clearBirthdayCaches();
    return { success: true, message: 'Attendee removed.' };
  } catch (e) {
    Logger.log('deleteAttendee error: ' + e.toString());
    return { success: false, message: 'Could not remove attendee: ' + e.toString() };
  } finally {
    try { lock.releaseLock(); } catch (e) {}
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
    if (formData.privacyConsent !== true && String(formData.privacyConsent).toLowerCase() !== 'true') {
      return { success: false, message: 'Please review and accept the privacy checklist before submitting.' };
    }

    const submittedName = String(formData.name || '').replace(/\s+/g, ' ').trim();
    if (!submittedName) return { success: false, message: 'Name is required.' };
    if (submittedName.length < 2) return { success: false, message: 'Please enter a valid name.' };

    const mobile = String(formData.mobile || '').trim();
    if (!mobile) return { success: false, message: 'Mobile is required.' };
    if (!/^\d{7,15}$/.test(mobile)) {
      return { success: false, message: 'Please enter a valid mobile number using numbers only.' };
    }
    if (!allowRateLimit('submitForm', normalizeName(submittedName) + '|' + mobile, 3)) return { success: false, message: 'Please wait a few minutes before submitting again.' };

    if (!formData.address || !String(formData.address).trim()) return { success: false, message: 'Address is required.' };
    if (!formData.greetings || !String(formData.greetings).trim()) return { success: false, message: 'Greetings are required.' };

    const attendance = String(formData.attendance || 'going').trim().toLowerCase();
    const validAttendance = ['going', 'planning', 'not_going'];
    if (!validAttendance.includes(attendance)) {
      return { success: false, message: 'Please choose an attendance option.' };
    }

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
        const existingRsvp = checkExistingRSVP(submittedName, mobile);
        return {
          success: false,
          duplicate: true,
          ticket: existingRsvp && existingRsvp.success ? existingRsvp.ticket : null,
          message: 'This name has already submitted an RSVP. Each player may submit only once.'
        };
      }

      const sheet = getResponsesSheet();

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

      sheet.appendRow([
        new Date(),
        submittedName,
        mobile,
        String(formData.address).trim(),
        String(formData.greetings).trim(),
        selfieUrl,
        identifier,
        guests,
        formData.loginMethod || 'name',
        ticketCode,
        '',
        attendance,
        videoUrl
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
   Upload a data URL (image or video) to a Drive folder.
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
    if (!allowRateLimit('adminLogin', 'global', 5)) return { success: false, message: 'Too many sign-in attempts. Please wait a few minutes and try again.' };
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

    const token = Utilities.getUuid();
    CacheService.getScriptCache().put(ADMIN_SESSION_PREFIX + token, '1', ADMIN_SESSION_TTL_SECONDS);
    Logger.log('Admin login succeeded');
    return { success: true, token: token, message: 'Welcome, admin.' };
  } catch (e) {
    return { success: false, message: e.toString() };
  }
}

/* ============================================================
   TICKET VERIFICATION (SCANNER)
   ============================================================ */
function isAdminSessionValid(token) {
  const sessionToken = String(token || '');
  if (!sessionToken || sessionToken.length > 64) return false;
  try {
    return CacheService.getScriptCache().get(ADMIN_SESSION_PREFIX + sessionToken) === '1';
  } catch (e) {
    return false;
  }
}

function verifyTicket(code, token) {
  if (!isAdminSessionValid(token)) {
    return { success: false, message: 'Admin session expired. Please sign in again.' };
  }

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
            videoUrl: String(row[COL.VIDEO_URL] || ''),
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

function checkInTicket(code, token) {
  if (!isAdminSessionValid(token)) {
    return { success: false, message: 'Admin session expired. Please sign in again.' };
  }

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

  const wallOfLove = spreadsheet.getSheetByName(SHEET_WALL_OF_LOVE) || spreadsheet.insertSheet(SHEET_WALL_OF_LOVE);
  wallOfLove.getRange(1, 1, 1, WALL_OF_LOVE_HEADERS.length).setValues([WALL_OF_LOVE_HEADERS]);
  Logger.log('✓ Wall of Love sheet is ready.');

  let leaderboard = spreadsheet.getSheetByName(SHEET_LEADERBOARD);
  if (!leaderboard) {
    leaderboard = spreadsheet.insertSheet(SHEET_LEADERBOARD);
    leaderboard.appendRow(LEADERBOARD_HEADERS);
    Logger.log('✓ Created "' + SHEET_LEADERBOARD + '"');
  } else {
    leaderboard.getRange(1, 1, 1, LEADERBOARD_HEADERS.length).setValues([LEADERBOARD_HEADERS]);
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

  const videoFolder = getOrCreateVideoFolder();
  Logger.log('✓ Video Greeting Drive folder: ' + videoFolder.getUrl());

  Logger.log('=== Setup complete ===');
  return 'Setup complete.';
}

function migrateResponsesForVideo() {
  const sh = getSheet(SHEET_RESPONSES, true);
  const headerRow = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0];

  if (headerRow.indexOf('Video Greeting URL') !== -1) {
    Logger.log('Header already has "Video Greeting URL". Nothing to migrate.');
    return 'Already up to date.';
  }

  const newColIndex = headerRow.length + 1;
  sh.getRange(1, newColIndex).setValue('Video Greeting URL');
  Logger.log('✓ Added "Video Greeting URL" header at column ' + newColIndex);

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
    videosDeleted: 0,
    settingsReset: false,
    leaderboardDeleted: 0,
    wallMessagesDeleted: 0
  };

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

  try {
    const wallOfLove = spreadsheet.getSheetByName(SHEET_WALL_OF_LOVE);
    if (wallOfLove) {
      const lastRow = wallOfLove.getLastRow();
      if (lastRow > 1) { summary.wallMessagesDeleted = lastRow - 1; wallOfLove.deleteRows(2, lastRow - 1); }
      wallOfLove.getRange(1, 1, 1, WALL_OF_LOVE_HEADERS.length).setValues([WALL_OF_LOVE_HEADERS]);
    }
  } catch (e) { Logger.log('Could not reset Wall of Love: ' + e.toString()); }

  try {
    const leaderboard = spreadsheet.getSheetByName(SHEET_LEADERBOARD);
    if (leaderboard) {
      const lastRow = leaderboard.getLastRow();
      if (lastRow > 1) {
        summary.leaderboardDeleted = lastRow - 1;
        leaderboard.deleteRows(2, lastRow - 1);
      }
      leaderboard.getRange(1, 1, 1, LEADERBOARD_HEADERS.length).setValues([LEADERBOARD_HEADERS]);
      cacheRemoveLeaderboard();
    }
  } catch (e) {
    Logger.log('Could not reset Leaderboard: ' + e.toString());
  }
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
    'Video files deleted: ' + summary.videosDeleted + '\n' +
    'Leaderboard rows deleted: ' + summary.leaderboardDeleted + '\n' +
    'Wall messages deleted: ' + summary.wallMessagesDeleted + '\n' +
    'Settings reset: ' + (summary.settingsReset ? 'yes' : 'no'),
    ui.ButtonSet.OK
  );

  return 'Reset complete.';
}

