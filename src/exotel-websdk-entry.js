// Browser entry for the Exotel CRM WebSDK.
// esbuild bundles this (and its dependencies) into public/vendor/exotel-websdk.bundle.js
// and exposes the SDK on the global window so plain <script> pages can use it.
import ExotelCRMWebSDK from "@exotel-npm-dev/exotel-ip-calling-crm-websdk";

window.ExotelCRMWebSDK = ExotelCRMWebSDK;
