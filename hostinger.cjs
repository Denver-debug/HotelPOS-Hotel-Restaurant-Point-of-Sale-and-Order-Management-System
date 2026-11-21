// Entry file for Hostinger's Node.js hosting, which loads the app with require(); index.js is an
// ES module, so import it and start the server here. PORT is passed as given: the platform may
// hand over a socket path, which config.port (a number) would replace with 3000.
import("./index.js")
  .then(({ startServer }) => startServer(process.env.PORT || 3000))
  .catch((err) => {
    console.error("❌ HotelPOS failed to start:", err);
    process.exit(1);
  });
