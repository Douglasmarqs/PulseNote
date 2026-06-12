import {
 signInWithEmailAndPassword
} from "firebase/auth";

import { auth } from "./firebase/auth";

async function login(){

 const email =
 document.getElementById("email").value;

 const password =
 document.getElementById("password").value;

 try{

   await signInWithEmailAndPassword(
     auth,
     email,
     password
   );

   window.location.href="/";

 }catch(error){

   alert(error.message);

 }

}