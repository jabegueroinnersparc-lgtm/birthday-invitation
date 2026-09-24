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
      // Make sure the header row is intact
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
