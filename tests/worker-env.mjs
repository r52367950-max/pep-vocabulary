// Unit tests emulate one trusted gateway explicitly; production has no default.
export const env = {
  IDENTITY_TRUSTED_HOSTS: 'app.test',
  // Explicitly approved mock providers; production only defaults to the two official origins.
  AI_ALLOWED_PROVIDER_ORIGINS: 'https://api.example.com,https://api.example.test,https://llm.example.test',
};
