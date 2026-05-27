const personalForm = document.getElementById('personal-form');
const personalAppName = document.getElementById('personal-app-name');
const personalButton = document.getElementById('personal-button');
const personalManifest = document.getElementById('personal-manifest');

const orgForm = document.getElementById('org-form');
const orgName = document.getElementById('org-name');
const orgAppName = document.getElementById('org-app-name');
const orgButton = document.getElementById('org-button');
const orgManifest = document.getElementById('org-manifest');

const errorHost = document.getElementById('error-host');

let manifest = null;
let lastOrgAppNameSuggestion = '';

const showError = (msg) => {
  const div = document.createElement('div');
  div.className = 'error';
  div.textContent = msg;
  errorHost.replaceChildren(div);
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
  .then((loaded) => {
    manifest = loaded;
    // Inject the redirect at runtime so forks served from a different
    // Pages domain work without editing the manifest file.
    manifest.redirect_url = location.origin + location.pathname.replace(/[^/]*$/, '') + 'install/';
    personalButton.disabled = false;
    orgButton.disabled = false;
  })
  .catch((err) => {
    showError('Could not load the manifest: ' + err.message + '. You can still set up Carson manually from the README.');
  });

// Auto-fill "Carson @ <org>" in the App name field as the user types the org
// name, unless they've already typed their own custom value.
orgName.addEventListener('input', () => {
  const org = orgName.value.trim();
  const suggestion = org ? 'Carson @ ' + org : '';

  if (orgAppName.value === '' || orgAppName.value === lastOrgAppNameSuggestion) {
    orgAppName.value = suggestion;
  }

  lastOrgAppNameSuggestion = suggestion;
});

// Override the manifest's default name with the user's choice before the form
// is submitted to GitHub. GitHub App names must be globally unique, so the
// shipped default ("Carson") will not work past the first install.
const injectName = (event, manifestInput, name) => {
  if (!manifest || !name) {
    event.preventDefault();
    return false;
  }

  manifest.name = name;
  manifestInput.value = JSON.stringify(manifest);
  return true;
};

personalForm.addEventListener('submit', (event) => {
  injectName(event, personalManifest, personalAppName.value.trim());
});

orgForm.addEventListener('submit', (event) => {
  const org = orgName.value.trim();

  if (!org) {
    event.preventDefault();
    return;
  }

  if (injectName(event, orgManifest, orgAppName.value.trim())) {
    orgForm.action = 'https://github.com/organizations/' + encodeURIComponent(org) + '/settings/apps/new';
  }
});
