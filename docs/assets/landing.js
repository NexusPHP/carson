const personalButton = document.getElementById('personal-button');
const orgButton = document.getElementById('org-button');
const orgForm = document.getElementById('org-form');
const orgName = document.getElementById('org-name');
const errorHost = document.getElementById('error-host');

const showError = (msg) => {
  errorHost.innerHTML = '<div class="error">' + msg + '</div>';
};

const manifestUrl = (() => {
  if (location.hostname.endsWith('.github.io')) {
    const owner = location.hostname.replace(/\.github\.io$/, '');
    const project = location.pathname.split('/').filter(Boolean)[0];
    if (project) {
      return 'https://raw.githubusercontent.com/' + owner + '/' + project + '/HEAD/.github/app-manifest.json';
    }
  }
  // Local dev or non-github.io hosting: serve the manifest from the same origin
  // at a path relative to docs/index.html.
  return '../.github/app-manifest.json';
})();

fetch(manifestUrl)
  .then((response) => {
    if (!response.ok) {
      throw new Error('Failed to load app-manifest.json (' + response.status + ')');
    }
    return response.json();
  })
  .then((manifest) => {
    // Inject the redirect at runtime so forks served from a different
    // Pages domain work without editing the manifest file.
    manifest.redirect_url = location.origin + location.pathname.replace(/[^/]*$/, '') + 'install/';
    const json = JSON.stringify(manifest);
    document.getElementById('personal-manifest').value = json;
    document.getElementById('org-manifest').value = json;
    personalButton.disabled = false;
    orgButton.disabled = false;
  })
  .catch((err) => {
    showError('Could not load the manifest: ' + err.message + '. You can still set up Carson manually from the README.');
  });

orgForm.addEventListener('submit', (event) => {
  const org = orgName.value.trim();
  if (!org) {
    event.preventDefault();
    return;
  }
  orgForm.action = 'https://github.com/organizations/' + encodeURIComponent(org) + '/settings/apps/new';
});
