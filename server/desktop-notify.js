import notifier from 'node-notifier';

export function sendDesktopNotification({ title, body }) {
  try {
    notifier.notify(
      {
        title: title || 'MailWatch',
        message: body || '',
        sound: true,
        appID: 'MailWatch',
        id: Date.now(),
        timeout: 8,
      },
      (err) => {
        if (err) console.error('[notify]', err.message);
      }
    );
  } catch (err) {
    console.error('[notify]', err.message);
  }
}