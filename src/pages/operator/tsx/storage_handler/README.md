# Firebase Storage Handler

Firebase is a set of application development platforms and backend cloud computing services. We use Firebase's Realtime Database for data storage, Authentication, and Hosting for the web interface.

## Set-up

### Creating a Firebase Project

1. Sign into [Firebase](https://firebase.google.com/) with your Google account.
1. Open the Firebase [console](https://console.firebase.google.com/) and create a new project. The project will default to using the no-cost [Spark plan](https://firebase.google.com/pricing?hl=en&authuser=1).
1. Add a web app to your Firebase project. You shouldn't need to worry about installing the Firebase SDK because it is already in the `package.json` dependencies for this repo. This will generate a configuration for your web app.

### Setting up the Realtime Database

1. Select the `Realtime Database` option under **Build** in the Firebase console for your project, then click **Create Database**.
1. Choose a location, select "Start in **locked mode**" in `Security Rules`, and click **Enable**.
1. Keep the database locked until the checked-in `database.rules.json` has been tested and the identity records below have been provisioned.

The checked-in rules are default-deny:

- **Identities and assignments:** clients may read only their own alias and assignment. Provisioning writes are administrator-only.
- **Robots:** assigned humans can read a robot and write validated launch/config/map requests. Only the canonical robot identity can write status/presence fields or consume control requests.
- **Maps:** humans and robots can read only explicitly assigned, owned, or allowlisted maps. Map writes are administrator-only.
- **Rooms and storage:** only assigned peers can read a room; signaling writes are bound to the authenticated uid and operator session. Operator data is private to its canonical alias.

### Setting up Authentication

1. Select the `Authentication` option under **Build** in the Firebase console for your project, then click **Get Started**.
1. Click **Email/Password** and enable it. Do not enable passwordless sign-in.
1. Add the **Google** provider, set the project public-facing name and support email, then save it. Do not enable Anonymous authentication; no application flow uses it.

### Configuring `.env` and `.firebaserc`

Update the `.env` file in the root of the workspace to include your Firebase config:

```env
# firebase config
apiKey=YOUR_API_KEY
authDomain=YOUR_PROJECT_ID.firebaseapp.com
projectId=YOUR_PROJECT_ID
storageBucket=YOUR_PROJECT_ID.firebasestorage.app
messagingSenderId=YOUR_MESSAGING_SENDER_ID
appId=YOUR_APP_ID
measurementId=YOUR_MEASUREMENT_ID

# user
roboUsername=snXXXX@hello-robot.com
roboPassword=your_secure_password

HELLO_FLEET_ID=stretch-seX-XXXX
```

`roboUsername` and `roboPassword` are robot-local secrets. Webpack allowlists only the public Firebase keys above and `HELLO_FLEET_ID`. The local Playwright launcher injects the robot account directly into the trusted robot browser context; never add these credentials to webpack definitions or URL parameters.

Update the `.firebaserc` file in the root of the workspace to link the repository to your Firebase project:

```json
{
  "projects": {
    "default": "YOUR_PROJECT_ID"
  }
}
```

## Deployment Steps

To deploy the web app to Firebase Hosting, install this repo's dependencies (`npm install`). That includes `firebase-tools`. You do not need a global Firebase CLI.

1. **Log in:**
   ```bash
   npm run firebase:login
   ```
1. **Build the web app:**
   `npm run build:firebase` writes the home, operator, and robot pages to `dist-firebase/`.
1. **Deploy the live site** (remote `main` only; other checkouts go to a preview channel when the interface is running):
   ```bash
   ./node_modules/.bin/firebase deploy --only hosting
   ```
   That uploads `dist-firebase/` and does not change Realtime Database rules or Auth.

### Realtime Database rules rollout

Rules are intentionally separate from Hosting:

1. Backfill and verify every robot identity:
   - `assignments/<robotAuthUid>/role = "robot"`
   - `assignments/<robotAuthUid>/name = "<fleetId>"`
   - `robots/<fleetId>/uid = "<robotAuthUid>"`
1. Ensure each human has `uids/<authUid> = "<alias>"` and only intended fleets/maps under `assignments/<alias>`.
1. Ensure robot-readable maps are assigned under `assignments/<fleetId>/maps` or include `<fleetId>: true` in `allowed_users`.
1. Roll this compatible signaling code out to every robot and the live Hosting channel; old preview clients do not include the session-bound seat metadata required by the new rules.
1. Run `npm run test:security`.
1. Validate in a staging project before explicitly publishing production rules:
   ```bash
   ./node_modules/.bin/firebase deploy --only database --dry-run
   ./node_modules/.bin/firebase deploy --only database
   ```

Never deploy strict rules before identity backfill: signaling deliberately fails closed when the robot assignment and fleet binding are missing or disagree.

## Connecting a new robot to the project

When adding a new robot to your Firebase project, ensure you update the `.env` file with the robot's specific credentials and fleet ID, and authorize it in Firebase.

1. Open the `.env` and `.firebaserc` files in the root directory.
1. Update the `.firebaserc` to link the new robot to your specific Firebase project ID:
   ```json
   {
     "projects": {
       "default": "YOUR_PROJECT_ID"
     }
   }
   ```
1. Update the `.env` file with the robot user credentials and fleet ID so the robot can authenticate and be identified in the Realtime Database:
   ```env
   # firebase config
   apiKey=YOUR_API_KEY
   authDomain=YOUR_PROJECT_ID.firebaseapp.com
   projectId=YOUR_PROJECT_ID
   storageBucket=YOUR_PROJECT_ID.firebasestorage.app
   messagingSenderId=YOUR_MESSAGING_SENDER_ID
   appId=YOUR_APP_ID
   measurementId=YOUR_MEASUREMENT_ID

   # user
   roboUsername=snXXXX@hello-robot.com
   roboPassword=your_secure_password

   HELLO_FLEET_ID=stretch-seX-XXXX
   ```
1. In the Firebase Console, go to **Authentication** > **Users** and click **Add user**. Add the `roboUsername` and `roboPassword` corresponding to the values set in the `.env` file, then copy the generated Auth uid.
1. Provision `assignments/<robotAuthUid>` with `{ "role": "robot", "name": "<fleetId>" }` and set `robots/<fleetId>/uid` to that same Auth uid.
1. Add human access under `assignments/<alias>/robots/<fleetId>` and map access under the human alias and/or fleet ID before deploying the checked-in rules.
