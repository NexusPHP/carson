const params = new URLSearchParams(location.search);
const code = params.get('code');
const statusEl = document.getElementById('status');
const resultEl = document.getElementById('result');
const errorHost = document.getElementById('error-host');

const showError = (...children) => {
  statusEl.hidden = true;
  const section = document.createElement('section');
  section.className = 'error';
  const strong = document.createElement('strong');
  strong.textContent = 'Error.';
  section.append(strong, ' ', ...children);
  errorHost.replaceChildren(section);
};

const appCreationLink = () => {
  const a = document.createElement('a');
  a.href = '../index.html';
  a.textContent = 'App creation page';
  return a;
};
const flashCopied = (button) => {
  const original = button.textContent;
  button.textContent = 'Copied';
  button.disabled = true;

  setTimeout(() => {
    button.textContent = original;
    button.disabled = false;
  }, 1500);
};

if (!code) {
  const codeEl = document.createElement('code');
  codeEl.textContent = 'code';
  showError(
    'No ',
    codeEl,
    ' parameter in the URL. This page is the redirect target of a GitHub App manifest flow and only works when reached that way. Start over at the ',
    appCreationLink(),
    '.',
  );
} else {
  fetch('https://api.github.com/app-manifests/' + encodeURIComponent(code) + '/conversions', {
    method: 'POST',
    headers: { Accept: 'application/vnd.github+json' },
  })
    .then((response) => {
      if (response.ok) {
        return response.json();
      }

      return response.json().then((body) => {
        throw new Error(body.message || ('HTTP ' + response.status));
      });
    })
    .then((data) => {
      statusEl.hidden = true;
      resultEl.hidden = false;

      document.getElementById('app-id').value = String(data.id);
      document.getElementById('app-name').textContent = data.name || '(unnamed)';
      document.getElementById('app-login').textContent = data.slug ? data.slug + '[bot]' : '(unknown)';

      const owner = data.owner;
      document.getElementById('app-owner').textContent = owner
        ? owner.login + ' (' + (owner.type || 'Account') + ')'
        : '(unknown)';
      const pemDisplay = document.getElementById('pem-display');
      pemDisplay.textContent = data.pem;

      const settingsLink = document.getElementById('app-settings-link');

      if (data.html_url) {
        settingsLink.href = data.html_url;
      } else {
        settingsLink.hidden = true;
      }

      document.getElementById('copy-app-id').addEventListener('click', (event) => {
        navigator.clipboard.writeText(String(data.id)).then(() => flashCopied(event.currentTarget));
      });
      document.getElementById('copy-pem').addEventListener('click', (event) => {
        navigator.clipboard.writeText(data.pem).then(() => flashCopied(event.currentTarget));
      });
      document.getElementById('copy-workflow').addEventListener('click', (event) => {
        navigator.clipboard.writeText(document.getElementById('workflow-yaml').textContent).then(() => flashCopied(event.currentTarget));
      });
      document.getElementById('copy-carson').addEventListener('click', (event) => {
        navigator.clipboard.writeText(document.getElementById('carson-yaml').textContent).then(() => flashCopied(event.currentTarget));
      });
      document.getElementById('reveal-pem').addEventListener('click', () => {
        pemDisplay.hidden = !pemDisplay.hidden;
      });
      document.getElementById('download-pem').addEventListener('click', () => {
        const blob = new Blob([data.pem], { type: 'application/x-pem-file' });
        const url = URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.href = url;
        link.download = 'carson-' + data.id + '.private-key.pem';
        link.click();
        URL.revokeObjectURL(url);
      });
    })
    .catch((err) => {
      showError(
        'Failed to exchange the code: ' + err.message + '. '
        + 'Codes are single-use and expire after about an hour. '
        + 'If you refreshed this page or returned to it after a delay, '
        + 'start over at the ',
        appCreationLink(),
        '.',
      );
    });
}
