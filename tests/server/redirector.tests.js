const nock = require("nock");
const jwt = require("jsonwebtoken");
const bodyParser = require("body-parser");
const { expect } = require("chai");
const { URL } = require("url");
const request = require("supertest");
const { describe, it, before, beforeEach } = require("mocha");
const Promise = require("bluebird");
const express = require("express");
const proxyquire = require("proxyquire").noCallThru();
const sinon = require("sinon");

let Auth0ClientStub = {};
const Auth0ExtentionToolsStub = {
  middlewares: {
    managementApiClient: () => (req, res, next) => {
      req.auth0 = Auth0ClientStub;
      next();
    }
  }
};

const config = require("../../server/lib/config");
const index = require("../../server/routes/index");
const api = proxyquire("../../server/routes/api", {
  "auth0-extension-express-tools": Auth0ExtentionToolsStub
});

describe("#idp-redirector/index", async () => {
  const defaultConfig = require("../../server/config.json");
  defaultConfig["PUBLIC_WT_URL"] =
    defaultConfig["PUBLIC_WT_URL"] || "https://test.webtask.com";

  const fakeDataDogHost = "https://datadog.internal";
  const fakeDataDogPath = "/v1/logs";
  defaultConfig["DATADOG_URL"] = fakeDataDogHost + fakeDataDogPath;

  config.setProvider(key => defaultConfig[key], null);

  const storage = {
    read: () => Promise.resolve(storage.data || {}),
    write: data => {
      storage.data = data;
      return Promise.resolve();
    }
  };

  const app = express();
  app.use("/", index(storage));
  app.use(bodyParser.json());
  app.use(bodyParser.urlencoded({ extended: false }));
  app.use((req, res, next) => {
    req.user = {
      scope: "read:patterns update:patterns"
    };
    next();
  });
  app.use("/api", api(storage));
  const baseUri = config("PUBLIC_WT_URL");

  let goodCode, badCode, missingIdTokenCode;
  const exampleUserId = "someuserid";
  const issuer = `https://${defaultConfig.AUTH0_DOMAIN}`;

  const errorPageUrl = "https://error.page";

  const getTenantSettingsStub = sinon
    .stub()
    .resolves({ error_page: { url: errorPageUrl } });
  Auth0ClientStub = { getTenantSettings: getTenantSettingsStub };

  before(done => {
    nock.cleanAll();

    nock(fakeDataDogHost)
      .post(fakeDataDogPath, () => true)
      .reply(200, {});

    request(app)
      .put("/api")
      .send([
        {
          clientName: "client name",
          loginUrl: "https://url1.com/login",
          patterns: ["https://url1.com", "https://url1.com/withPath*"]
        },
        {
          patterns: ["https://url2.com?*"],
          clientName: "client 2"
        }
      ])
      .end(err => {
        if (err) return done(err);
        done();
      });
  });

  beforeEach(() => {
    sinon.resetHistory();
    global = {};
  });

  describe("GET /", () => {
    beforeEach(() => {
      goodCode = "goodcode";
      badCode = "badcode";
      missingIdTokenCode = "missingcode";

      nock(issuer)
        .post("/oauth/token", {
          grant_type: "authorization_code",
          client_id: defaultConfig.AUTH0_CLIENT_ID,
          client_secret: defaultConfig.AUTH0_CLIENT_SECRET,
          redirect_uri: baseUri,
          code: goodCode
        })
        .reply(200, {
          id_token: jwt.sign(
            {
              sub: exampleUserId,
              aud: defaultConfig.AUTH0_CLIENT_ID,
              iss: issuer,
              iat: Date.now(),
              exp: Date.now() + 3600
            },
            "shhhhh"
          )
        });

      nock(issuer)
        .post("/oauth/token", {
          grant_type: "authorization_code",
          client_id: defaultConfig.AUTH0_CLIENT_ID,
          client_secret: defaultConfig.AUTH0_CLIENT_SECRET,
          redirect_uri: baseUri,
          code: badCode
        })
        .reply(403, {
          error: "invalid_grant",
          error_description: "Invalid authorization code"
        });

      nock(issuer)
        .post("/oauth/token", {
          grant_type: "authorization_code",
          client_id: defaultConfig.AUTH0_CLIENT_ID,
          client_secret: defaultConfig.AUTH0_CLIENT_SECRET,
          redirect_uri: baseUri,
          code: missingIdTokenCode
        })
        .reply(200, {});
    });

    describe("good logger", () => {
      beforeEach(() => {
        nock(fakeDataDogHost)
          .post(fakeDataDogPath, () => true)
          .reply(200, {});
      });

      it("should redirect to loginUrl with correct parameters", done => {
        const targetUrl = "https://url1.com/withPath/abc?q=xyz";
        request(app)
          .get("/")
          .query({
            state: targetUrl,
            code: goodCode
          })
          .send()
          .expect(302)
          .end((err, res) => {
            if (err) return done(err);

            const target = new URL(res.headers["location"]);

            expect(target.origin).to.equal("https://url1.com");
            expect(target.pathname).to.equal("/login");
            expect(target.searchParams.get("target_link_uri")).to.be.equal(
              targetUrl
            );
            expect(target.searchParams.get("iss")).to.be.equal(
              `https://${config("AUTH0_DOMAIN")}`
            );

            done();
          });
      });

      it("should redirect to state with correct parameters", done => {
        const targetUrl = "https://url2.com?q=xyz";
        request(app)
          .get("/")
          .query({
            state: targetUrl,
            code: goodCode
          })
          .send()
          .expect(302)
          .end((err, res) => {
            if (err) return done(err);

            const target = new URL(res.headers["location"]);

            expect(target.origin).to.equal("https://url2.com");
            expect(target.pathname).to.equal("/");
            expect(target.search).to.include("q=xyz");
            expect(target.searchParams.get("target_link_uri")).to.be.equal(
              targetUrl
            );
            expect(target.searchParams.get("iss")).to.be.equal(
              `https://${config("AUTH0_DOMAIN")}`
            );

            done();
          });
      });

      it("should redirect to loginUrl with error & error_description", done => {
        const targetUrl = "https://url1.com/withPath/abc?q=xyz";
        request(app)
          .get("/")
          .query({
            state: targetUrl,
            error: "invalid_client",
            error_description: "invalid client"
          })
          .send()
          .expect(302)
          .end((err, res) => {
            if (err) return done(err);

            const target = new URL(res.headers["location"]);

            expect(target.origin).to.equal("https://url1.com");
            expect(target.pathname).to.equal("/login");
            expect(target.searchParams.get("target_link_uri")).to.be.equal(
              targetUrl
            );
            expect(target.searchParams.get("iss")).to.be.equal(
              `https://${config("AUTH0_DOMAIN")}`
            );

            expect(target.searchParams.get("error")).to.be.equal(
              "invalid_client"
            );
            expect(target.searchParams.get("error_description")).to.be.equal(
              "invalid client"
            );

            done();
          });
      });

      it("should redirect to /error when state url doesn't match whitelist", done => {
        request(app)
          .get("/")
          .query({
            state: "https://example.com/login/callback"
          })
          .send()
          .expect(302)
          .end((err, res) => {
            if (err) return done(err);

            const target = new URL(res.headers["location"], "https://x.com");

            expect(target.origin).to.equal(errorPageUrl);
            expect(target.pathname).to.equal("/");
            expect(target.searchParams.get("error")).to.be.equal(
              "invalid_host"
            );

            done();
          });
      });

      it("should redirect to loginUrl with an error when we use a bad code", done => {
        const targetUrl = "https://url1.com/withPath/abc?q=xyz";
        request(app)
          .get("/")
          .query({
            state: targetUrl,
            code: badCode
          })
          .send()
          .expect(302)
          .end((err, res) => {
            if (err) return done(err);

            const target = new URL(res.headers["location"], "https://x.com");

            expect(target.origin).to.equal("https://url1.com");
            expect(target.pathname).to.equal("/login");
            expect(target.searchParams.get("error")).to.be.equal(
              "invalid_request"
            );
            expect(target.searchParams.get("error_description")).to.be.equal(
              "[CE001] Invalid User Code"
            );

            done();
          });
      });

      it("should redirect to loginUrl with an error when we don't get an id token", done => {
        const targetUrl = "https://url1.com/withPath/abc?q=xyz";
        request(app)
          .get("/")
          .query({
            state: targetUrl,
            code: missingIdTokenCode
          })
          .send()
          .expect(302)
          .end((err, res) => {
            if (err) return done(err);

            const target = new URL(res.headers["location"], "https://x.com");

            expect(target.origin).to.equal("https://url1.com");
            expect(target.pathname).to.equal("/login");
            expect(target.searchParams.get("error")).to.be.equal(
              "invalid_request"
            );
            expect(target.searchParams.get("error_description")).to.be.equal(
              "[CE002] Invalid User Code"
            );

            done();
          });
      });

      it("should redirect to loginUrl with an error when oauth token fails with 500", done => {
        const targetUrl = "https://url1.com/withPath/abc?q=xyz";
        request(app)
          .get("/")
          .query({
            state: targetUrl,
            code: "some code without a nock"
          })
          .send()
          .expect(302)
          .end((err, res) => {
            if (err) return done(err);

            const target = new URL(res.headers["location"], "https://x.com");

            expect(target.origin).to.equal("https://url1.com");
            expect(target.pathname).to.equal("/login");
            expect(target.searchParams.get("error")).to.be.equal(
              "invalid_request"
            );
            expect(target.searchParams.get("error_description")).to.be.equal(
              "[CE003] Invalid User Code"
            );

            done();
          });
      });
    });

    describe("bad logger", () => {
      beforeEach(() => {
        nock(fakeDataDogHost)
          .post(fakeDataDogPath, () => true)
          .reply(500, { error: "internal_error" });
      });

      it("should redirect to loginUrl with correct parameters: even if datadog logging fails", done => {
        const targetUrl = "https://url1.com/withPath/abc?q=xyz";
        request(app)
          .get("/")
          .query({
            state: targetUrl,
            code: goodCode
          })
          .send()
          .expect(302)
          .end((err, res) => {
            if (err) return done(err);

            const target = new URL(res.headers["location"]);

            expect(target.origin).to.equal("https://url1.com");
            expect(target.pathname).to.equal("/login");
            expect(target.searchParams.get("target_link_uri")).to.be.equal(
              targetUrl
            );
            expect(target.searchParams.get("iss")).to.be.equal(
              `https://${config("AUTH0_DOMAIN")}`
            );

            done();
          });
      });
    });
  });

  describe("GET / with errors", () => {
    beforeEach(() => {
      nock("https://http-intake.logs.datadoghq.com")
        .post("/v1/input", () => true)
        .reply(200, {});
    });

    it("should NOT load error_page from tenant settings", done => {
      request(app)
        .get("/?state=bad")
        .send()
        .end(err => {
          if (err) return done(err);

          expect(getTenantSettingsStub).to.have.callCount(0);
          done();
        });
    });

    it("should NOT cache tenant error_page in global", async () => {
      for (const error of ["invalid_host", "invalid_request", "bad_request"]) {
        await request(app)
          .get("/?state=bad")
          .query({
            error
          });
      }
      expect(getTenantSettingsStub).to.have.callCount(0);
    });
  });
});
