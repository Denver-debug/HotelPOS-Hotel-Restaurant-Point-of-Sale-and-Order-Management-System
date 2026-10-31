// Runs before every test file (jest setupFiles). Forces the disposable test database
// and known seed credentials. process.loadEnvFile() never overrides variables set here.
process.env.NODE_ENV = "test";
process.env.SEED_ADMIN_PASSWORD = "TestPass123";
process.env.HR_VALIDATE_ON_LOGIN = "true";
process.env.PMS_ADAPTER = "mock";
process.env.PAYMENT_ADAPTER = "mock";
process.env.PMS_MOCK_DELAY_MS = "0";
