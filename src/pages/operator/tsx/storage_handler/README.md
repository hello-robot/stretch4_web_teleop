# Firebase Storage Handler

Firebase is a set of application development platforms and backend cloud computing services. We use Firebase's Realtime Database for data storage, Authentication, and Hosting for the web interface.

## Set-up

### Creating a Firebase Project

1. Sign into [Firebase](https://firebase.google.com/) with your Google account.
2. Open the Firebase [console](https://console.firebase.google.com/) and create a new project. The project will default to using the no-cost [Spark plan](https://firebase.google.com/pricing?hl=en&authuser=1).
3. Add a web app to your Firebase project. You shouldn't need to worry about installing the Firebase SDK because it is already in the `package.json` dependencies for this repo. This will generate a configuration for your web app.

### Setting up the Realtime Database

1. Select the `Realtime Database` option under **Build** in the Firebase console for your project, then click **Create Database**. 
2. Choose a location, select "Start in **locked mode**" in `Security Rules`, and click **Enable**. 
3. Go to the **Rules** tab and configure your database rules to handle security and access control. 

At a high level, your database rules should enforce the following security policies:
- **Authentication:** Ensure that all database paths require users to be authenticated (`auth != null`).
- **User Profiles:** Restrict users so they can only read and write their own personal profile data.
- **Robots:** Allow robot states to be readable by authenticated users, but writable only by the robot itself, its assigned owners, or users explicitly granted access.
- **Maps:** Enforce strict access controls on maps. Maps should only be read by their owner, users in an allowed list, users with explicit assignments, or operators currently controlling a robot that has access to the map. Map modifications should be restricted to the map's owner.
- **Shared Data:** Global settings like layouts, operators, and rooms can generally be read by all authenticated users, but you may want to restrict write access to the specific operator or administrators.

### Setting up Authentication

1. Select the `Authentication` option under **Build** in the Firebase console for your project, then click **Get Started**. 
2. Click **Email/Password** and enable it. Do not enable passwordless sign-in. 
3. Click **Add new Provider** and select **Anonymous**, then enable it and click **Save**. 
4. Finally, add another provider, click **Google**, add a `Project public-facing name`, select a support email, and click **Save**. We will primarily be using `Google` for user authentication.

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

Update the `.firebaserc` file in the root of the workspace to link the repository to your Firebase project:

```json
{
  "projects": {
    "default": "YOUR_PROJECT_ID"
  }
}
```

## Deployment Steps

To deploy the web app to Firebase Hosting, you will need the Firebase CLI.

1. **Install Firebase CLI:**
   ```bash
   npm install -g firebase-tools
   ```
2. **Login to Firebase:**
   ```bash
   firebase login
   ```
3. **Build the Web App:**
   Make sure you build the production bundle of the React app (which goes into the `dist/` folder).
   ```bash
   npm run build
   ```
4. **Deploy:**
   Once authenticated, and with your `.firebaserc` properly set up, you can deploy your application (Hosting and Auth configs defined in `firebase.json`):
   ```bash
   firebase deploy
   ```

## Connecting a new robot to the project

When adding a new robot to your Firebase project, ensure you update the `.env` file with the robot's specific credentials and fleet ID, and authorize it in Firebase.

1. Open the `.env` and `.firebaserc` files in the root directory.
2. Update the `.firebaserc` to link the new robot to your specific Firebase project ID:
   ```json
   {
     "projects": {
       "default": "YOUR_PROJECT_ID"
     }
   }
   ```
3. Update the `.env` file with the robot user credentials and fleet ID so the robot can authenticate and be identified in the Realtime Database:
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
3. In the Firebase Console, go to **Authentication** > **Users** and click **Add user**. Add the `roboUsername` and `roboPassword` corresponding to the values set in the `.env` file.
4. Ensure that your Realtime Database rules are configured to grant this new robot write access to its corresponding `robots/$robot_id` path, as well as read access to any maps or layouts it is assigned to.
