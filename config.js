/**
 * Safe to commit. The endpoint is useless on its own — every request is
 * rejected without the token, and the token is never stored in this file.
 *
 * Each device receives the token once via a private setup link:
 *   https://<host>/index.html?token=<TOKEN>&who=Sam
 * The page saves it to that device and strips it from the URL. Leave `token`
 * empty here so the public page ships with no secret in it.
 */

var CONFIG = {
  // The /exec URL from the Apps Script deployment (not the /dev one).
  endpoint: 'https://script.google.com/macros/s/AKfycbz19gUpjlfRoh_pLwf0Chz30Glwqo7BYnTQSLNs5JDuOqxVcoLoQczmt99kEINbFoaf/exec',
  token: ''
};
