import {
 createUserWithEmailAndPassword
} from "firebase/auth";

import {
 doc,
 setDoc
} from "firebase/firestore";

import { auth } from "./firebase/auth";
import { db } from "./firebase/firestore";

async function cadastrar(){

 const nome =
 document.getElementById("nome").value;

 const email =
 document.getElementById("email").value;

 const senha =
 document.getElementById("senha").value;

 const userCredential =
 await createUserWithEmailAndPassword(
   auth,
   email,
   senha
 );

 await setDoc(
   doc(db,"users",userCredential.user.uid),
   {
     nome,
     email,
     createdAt:new Date()
   }
 );

}