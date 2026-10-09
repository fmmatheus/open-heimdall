import { connectHost } from '@openchamber/sdk';
import { applyHostReady, mountEmpty } from '@openchamber/sdk/ui';

const host = connectHost();
const content = document.getElementById('content');
if (content) {
  mountEmpty(content, {
    title: 'Heimdall',
    body: 'No Heimdall runs to show yet.',
  });
}

host.onReady((context) => {
  applyHostReady(context, document.documentElement);
});
