import { initializeApp } from "firebase/app";
import { getDatabase } from "firebase/database";
import { getAuth, signInAnonymously } from "firebase/auth";

const firebaseConfig = {
  apiKey: "AIzaSyAaalQCKGcaCSewAZyyNoZzCH3_Jh0V-MI",
  authDomain: "aurelio-ski-77530.firebaseapp.com",
  databaseURL: "https://aurelio-ski-77530-default-rtdb.firebaseio.com",
  projectId: "aurelio-ski-77530",
  storageBucket: "aurelio-ski-77530.firebasestorage.app",
  messagingSenderId: "483669179979",
  appId: "1:483669179979:web:3d651d5e9dc560581417ce",
  measurementId: "G-N3XVLGCD7Y"
};

const app = initializeApp(firebaseConfig);

export const db = getDatabase(app);

export const auth = getAuth(app);

export async function ensureAuth() {
  if (!auth.currentUser) await signInAnonymously(auth)
  return auth.currentUser
}