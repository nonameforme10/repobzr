// Import the functions you need from the SDKs you need
import { initializeApp } from "firebase/app";
import { getAnalytics } from "firebase/analytics";
// TODO: Add SDKs for Firebase products that you want to use
// https://firebase.google.com/docs/web/setup#available-libraries

// Your web app's Firebase configuration
// For Firebase JS SDK v7.20.0 and later, measurementId is optional
const firebaseConfig = {
  apiKey: "AIzaSyBQzxo2CN8gjKjtfR01JNTit6FHgw2z1MY",
  authDomain: "bozor-b05d3.firebaseapp.com",
  projectId: "bozor-b05d3",
  storageBucket: "bozor-b05d3.firebasestorage.app",
  messagingSenderId: "24176997862",
  appId: "1:24176997862:web:111d3406ae7f1c639c9227",
  measurementId: "G-893XN139E1"
};

// Initialize Firebase
const app = initializeApp(firebaseConfig);
const analytics = getAnalytics(app);