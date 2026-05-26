const params = new URLSearchParams(location.search);
const code = params.get('code');
const statusEl = document.getElementById('status');
const resultEl = document.getElementById('result');
const errorHost = document.getElementById('error-host');

const showError = (msg) => {
  statusEl.hidden = true;
  errorHost.innerHTML = '<section class="error"><strong>Error.</strong> ' + msg + '</section>';
};

if (!code) {
  showError('No <code>code</code> parameter in the URL. This page is the redirect target of a GitHub App manifest flow and only works when reached that way. Start over from the <a href="../">install page</a>.');
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

      const installHost = document.getElementById('install-link-host');
      if (data.html_url) {
        installHost.innerHTML = 'The install link is on <a href="' + data.html_url + '/installations/new" rel="noopener">the App settings page</a>.';
      }

      document.getElementById('copy-app-id').addEventListener('click', () => {
        navigator.clipboard.writeText(String(data.id));
      });
      document.getElementById('copy-pem').addEventListener('click', () => {
        navigator.clipboard.writeText(data.pem);
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
        + 'start over from the <a href="../">install page</a>.',
      );
    });
}
