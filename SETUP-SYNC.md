# Setting up sync and reminders

AlCal keeps working offline on every device. Sync adds a small private server that holds a copy of your
events, projects and items, passes changes between your devices, and sends reminder notifications.
The server runs on Cloudflare's free plan and is deployed from this repository by a GitHub Action.

This takes about 15 minutes, once.

## 1. Create a Cloudflare account

1. Sign up for free at <https://dash.cloudflare.com/sign-up>.
2. In the dashboard, open **Workers & Pages** once. If it asks you to choose a **workers.dev subdomain**,
   pick any name (for example your initials). Your server address will be
   `https://alcal-sync.<that-name>.workers.dev`.

## 2. Collect three values

- **API token:** click the profile icon (top right) > **My Profile** > **API Tokens** > **Create Token**
  > template **Edit Cloudflare Workers** > **Use template** > leave the defaults > **Continue to summary**
  > **Create Token**. Copy the token (it is shown only once).
- **Account ID:** on the dashboard home, open the menu next to your account name and choose
  **Copy account ID** (it is also shown on the right side of the Workers & Pages overview).
- **Sync key:** make up a long passphrase, for example five or six random words. This is the password
  for your data, so do not reuse one from elsewhere. Keep it in your password manager.

## 3. Store them in GitHub

In this repository on github.com: **Settings** > **Secrets and variables** > **Actions** >
**New repository secret**. Add three secrets with exactly these names:

| Name                    | Value             |
|-------------------------|-------------------|
| `CLOUDFLARE_API_TOKEN`  | the API token     |
| `CLOUDFLARE_ACCOUNT_ID` | the account ID    |
| `ALCAL_SYNC_KEY`        | your sync key     |

## 4. Deploy the server

Open the **Actions** tab > **Deploy sync server** > **Run workflow** > **Run workflow**.
After about a minute the run turns green. Open it and look in the "Deploy to Cloudflare" step for the
address ending in `.workers.dev`. Opening that address in a browser should say
"AlCal sync server is running."

Later changes to the `server/` folder deploy automatically when they are pushed.

## 5. Connect each device

In AlCal: **...** menu (or the cloud icon at the top right) > **Sync & reminders**. Enter the server
address and your sync key, then **Connect**. Do this on your laptop and on your iPhone. Data that is
already on a device is merged in, so nothing gets lost.

## 6. Turn on notifications

In the same panel, tap **Turn on notifications** on each device, then **Send a test**.

- **iPhone:** this only works when AlCal is opened from its Home Screen icon, on iOS 16.4 or later.
  Notifications then arrive even when AlCal is closed.
- **Laptop:** Chrome, Edge and Safari deliver them while the browser is running, even if AlCal is closed.

Events get a reminder field in the event editor (new events default to 15 minutes before; change the
default in the panel). Planner items can remind you on, or a day or a week before, their due date.

## How it behaves

- Changes sync a second or two after you make them, whenever a device is online, and every minute
  while AlCal is open. Offline changes sync when the connection returns.
- If the same thing is edited on two devices before they sync, the later edit wins.
- Reminders are scheduled up to 45 days ahead and refreshed every time a device syncs, so a
  repeating event keeps reminding you as long as you open AlCal on any device now and then.
- The server stores your data and the titles of upcoming reminders (they are the notification text).
  It is reachable only with your sync key. To change the key: update the `ALCAL_SYNC_KEY` secret,
  run the workflow again, and reconnect each device with the new key.

## Claude as your secretary (optional)

The sync server also works as a connector for Claude. With it, Claude can add, move and delete events,
find free time, manage planner projects and items, and add to the Purchase, Reading and Ideas lists,
from any Claude chat on the web or on your iPhone.

1. In AlCal, open **Sync & reminders**. Once a device is connected, a **Claude connector** section shows
   the connector address. Tap **Copy address**.
2. In Claude on the web: **Settings** > **Connectors** > **Add custom connector**. Give it a name
   (for example "AlCal"), paste the address, and add it. It is then available on your iPhone as well.
3. In a chat, make sure the AlCal connector is switched on, then just ask: "Add dinner with Dad on Saturday
   at 7 at Kao Chi, remind me an hour before", "What does next week look like?", "Put 'draft section 3'
   in the GEMA project, due Friday", "Add Law's Empire to my academic books".

Notes:

- Changes appear on your devices within about a minute while AlCal is open, and reminders for new events
  are scheduled right away.
- Claude reads and writes times in the time zone of the device that synced last. You can name another
  zone in your request ("4 pm London time").
- Deletions work like in the app: the record is marked deleted, not erased.
- The address contains a secret derived from your sync key. Keep it private. Changing the sync key
  also changes the address, so you would then add the connector again.
