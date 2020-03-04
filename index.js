import ImapClient from 'emailjs-imap-client';
import { google } from 'googleapis';
import open from 'open';
import fs from 'fs';
import readline from 'readline';
import puppeteer from 'puppeteer';
import _ from 'lodash';
import moment from 'moment';
import { JSDOM } from 'jsdom';
const csv = require('fast-csv');
import pLimit from 'p-limit';

const MAX_CONCURRENT_PAGES = 150;

(async () => {
  function getGoogleToken() {
    return new Promise(function(resolve, reject) {
      // do a thing, possibly async, then…
      //ref: https://developers.google.com/gmail/api/quickstart/nodejs
      //ref: https://developers.google.com/gmail/api/v1/reference/users/messages/list
      //ref: https://medium.com/@nickroach_50526/sending-emails-with-node-js-using-smtp-gmail-and-oauth2-316fe9c790a1

      // If modifying these scopes, delete token.json.
      const SCOPES = ['https://www.googleapis.com/auth/gmail.readonly'];
      // The file token.json stores the user's access and refresh tokens, and is
      // created automatically when the authorization flow completes for the first
      // time.
      const TOKEN_PATH = 'token.json';

      // Load client secrets from a local file.
      fs.readFile('credentials.json', (err, content) => {
        if (err) return console.log('Error loading client secret file:', err);
        // Authorize a client with credentials, then call the Gmail API.
        //   authorize(JSON.parse(content), listLabels);
        authorize(JSON.parse(content), resolve);
      });

      /**
       * Create an OAuth2 client with the given credentials, and then execute the
       * given callback function.
       * @param {Object} credentials The authorization client credentials.
       * @param {function} callback The callback to call with the authorized client.
       */
      function authorize(credentials, callback) {
        const { client_secret, client_id, redirect_uris } = credentials.installed;
        const oAuth2Client = new google.auth.OAuth2(client_id, client_secret, redirect_uris[0]);

        // Check if we have previously stored a token.
        fs.readFile(TOKEN_PATH, (err, token) => {
          if (err) return getNewToken(oAuth2Client, callback);
          oAuth2Client.setCredentials(JSON.parse(token));
          callback(oAuth2Client);
        });
      }

      /**
       * Get and store new token after prompting for user authorization, and then
       * execute the given callback with the authorized OAuth2 client.
       * @param {google.auth.OAuth2} oAuth2Client The OAuth2 client to get token for.
       * @param {getEventsCallback} callback The callback for the authorized client.
       */
      function getNewToken(oAuth2Client, callback) {
        const authUrl = oAuth2Client.generateAuthUrl({
          access_type: 'offline',
          scope: SCOPES,
        });
        console.log('Authorize this app by visiting this url:', authUrl);
        open(authUrl, { wait: true });

        const rl = readline.createInterface({
          input: process.stdin,
          output: process.stdout,
        });
        rl.question('Enter the code from that page here: ', code => {
          rl.close();
          oAuth2Client.getToken(code, (err, token) => {
            if (err) {
              reject(Error('Error retrieving access token' + err));
              return;
            }
            oAuth2Client.setCredentials(token);
            // Store the token to disk for later program executions
            fs.writeFile(TOKEN_PATH, JSON.stringify(token), err => {
              if (err) {
                reject(Error(err));
                return;
              }
              console.log('Token stored to', TOKEN_PATH);
            });
            callback(oAuth2Client);
          });
        });
      }

      /**
       * Lists the labels in the user's account.
       *
       * @param {google.auth.OAuth2} auth An authorized OAuth2 client.
       */
      function listLabels(auth) {
        const gmail = google.gmail({ version: 'v1', auth });
        gmail.users.labels.list(
          {
            userId: 'me',
          },
          (err, res) => {
            if (err) return console.log('The API returned an error: ' + err);
            const labels = res.data.labels;
            if (labels.length) {
              console.log('Labels:');
              labels.forEach(label => {
                console.log(`- ${label.name}`);
              });
            } else {
              console.log('No labels found.');
            }
          }
        );
      }
    });
  }

  let auth = await getGoogleToken();

  // console.log(auth);
  const gmail = google.gmail({ version: 'v1', auth });

  function list(key, param) {
    return new Promise(function(resolve, reject) {
      function list_recurse(key, param, results = []) {
        gmail.users[key].list(param, (err, res) => {
          if (err) return reject(Error('The API returned an error: ' + err));
          let data = res.data;
          // console.log(data[key]);
          results = results.concat(data[key]);
          if (data.nextPageToken) {
            let next_param = Object.assign({}, param);
            next_param['pageToken'] = data.nextPageToken;
            //   console.log(next_param);
            list_recurse(key, next_param, results);
          } else {
            resolve(results);
          }
        });
      }
      list_recurse(key, param, []);
    });
  }

  function get(key, param) {
    return new Promise(function(resolve, reject) {
      gmail.users[key].get(param, (err, res) => {
        if (err) return reject(Error('The API returned an error: ' + err));
        let data = res.data;
        resolve(data);
      });
    });
  }

  let headless = true;
  // headless = false;
  puppeteer.launch({ headless: headless }).then(async browser => {
    //ref: https://github.com/puppeteer/puppeteer/issues/471#issuecomment-324086023

    const limit = pLimit(MAX_CONCURRENT_PAGES);

    console.time('Extraction');

    let configs = [
      {
        namespace: 'MyCar',
        // skip: true,
        gmail_query: 'subject:(Your MyCar Receipt)',
        // gmail_query: 'subject:(Your MyCar Receipt) before:2020/1/1 after:2019/1/1',
        parser: async (page, html) => {
          // const dom = new JSDOM(html);

          // var elements = dom.window.document.querySelectorAll('td.produceTdLast')
          // var element = dom.window.document.querySelector('td.produceTdLast');
          // const result = element.textContent;

          // console.log(elements);

          //   const results = await page.$$eval('td.produceTdLast', elements => elements.map(element => element.innerHTML));
          const results = await page.$$eval('tr', elements => elements.map(element => element.textContent));
          // const result = await page.$eval('td', element => element.textContent);

          let total = null;
          results.reverse().some(result => {
            if (result.includes('TOTAL')) {
              //   console.log('result', result);
              let matches = result.match(/[0-9]+\.[0-9]{1,2}/);
              total = matches[0];
              return true;
            }
          });

          let metadata = {};
          return { total, metadata };
        },
      },
      {
        namespace: 'Grab_Transport',
        // skip: true,
        gmail_query: 'subject:(Your Grab E-Receipt) Hope you had an enjoyable ride!',
        // gmail_query: 'subject:(Your Grab E-Receipt) Hope you had an enjoyable ride! before:2020/1/1 after:2019/1/1',
        parser: async (page, html) => {
          // const dom = new JSDOM(html);

          // var elements = dom.window.document.querySelectorAll('td.produceTdLast')
          // var element = dom.window.document.querySelector('td.produceTdLast');
          // const result = element.textContent;

          // console.log(elements);

          /* await page.evaluate(() => {
                        var elements = document.querySelectorAll('td.produceTdLast');
                        console.log(elements);
                      }); */

          // const results = await page.$$eval('td.produceTdLast', elements => elements.map(element => element.innerHTML));
          // const results = await page.$$eval('td.produceTdLast', elements => elements.map(element => element.textContent));
          const result = await page.$eval('td.produceTdLast', element => element.textContent);

          let matches = result.match(/[0-9]+\.[0-9]{1,2}/);

          let total = matches[0];
          let metadata = {};
          return { total, metadata };
        },
      },
      {
        namespace: 'GrabFood',
        // skip: true,
        gmail_query: 'subject:(Your Grab E-Receipt) Hope you enjoyed your food!',
        // gmail_query: 'subject:(Your Grab E-Receipt) Hope you had an enjoyable ride! before:2020/1/1 after:2019/1/1',
        parser: async (page, html) => {
          // const dom = new JSDOM(html);

          // var elements = dom.window.document.querySelectorAll('td.produceTdLast')
          // var element = dom.window.document.querySelector('td.produceTdLast');
          // const result = element.textContent;

          // console.log(elements);

          /* await page.evaluate(() => {
                        var elements = document.querySelectorAll('td.produceTdLast');
                        console.log(elements);
                      }); */

          // const results = await page.$$eval('td.produceTdLast', elements => elements.map(element => element.innerHTML));
          // const results = await page.$$eval('td.produceTdLast', elements => elements.map(element => element.textContent));
          const result = await page.$eval('td.produceTdLast', element => element.textContent);

          let matches = result.match(/[0-9]+\.[0-9]{1,2}/);

          let total = matches[0];
          let metadata = {};
          return { total, metadata };
        },
      },
      {
        namespace: 'GrabFood',
        // skip: true,
        gmail_query: 'from:GrabFood subject:(Order Confirmation for) Your order from',
        parser: async (page, html) => {
          // const dom = new JSDOM(html);

          // var elements = dom.window.document.querySelectorAll('td.produceTdLast')
          // var element = dom.window.document.querySelector('td.produceTdLast');
          // const result = element.textContent;

          // console.log(elements);

          //   const results = await page.$$eval('td.produceTdLast', elements => elements.map(element => element.innerHTML));
          const results = await page.$$eval('td > div', elements => elements.map(element => element.textContent));
          // const result = await page.$eval('td', element => element.textContent);

          let total = null;
          results.reverse().some(result => {
            if (result.includes('Total')) {
              //   console.log('result', result);
              let matches = result.match(/[0-9]+\.[0-9]{1,2}/);
              total = matches[0];
              return true;
            }
          });

          if (!total) {
            const result = await page.$eval('h2', element => element.textContent);
            if (result.includes('Paid with')) {
              let matches = result.match(/[0-9]+\.[0-9]{1,2}/);
              total = matches[0];
            }
          }

          let metadata = {};
          return { total, metadata };
        },
      },
      {
        namespace: 'Foodpanda',
        // skip: true,
        gmail_query: 'subject:(Your foodpanda order) Invoice',
        parser: async (page, html) => {
          // const dom = new JSDOM(html);

          // var elements = dom.window.document.querySelectorAll('td.produceTdLast')
          // var element = dom.window.document.querySelector('td.produceTdLast');
          // const result = element.textContent;

          // console.log(elements);

          //   const results = await page.$$eval('td.produceTdLast', elements => elements.map(element => element.innerHTML));
          const results = await page.$$eval('tr', elements => elements.map(element => element.textContent));
          // const result = await page.$eval('td', element => element.textContent);

          let total = null;
          results.reverse().some(result => {
            if (result.includes('Total')) {
              //   console.log('result', result);
              let matches = result.match(/[0-9]+\.[0-9]{1,2}/);
              total = matches[0];
              return true;
            }
          });

          let metadata = {};
          return { total, metadata };
        },
      },
    ];

    let promises = [];
    let csvStreams = {};

    configs.forEach(config => {
      if (config.skip) {
        return;
      }
      promises.push(
        list('messages', {
          userId: 'me',
          //   q: 'subject:(Your Grab E-Receipt) Hope you had an enjoyable ride! before:2020/1/1 after:2019/10/1',
          // q: 'subject:(Your Grab E-Receipt) Hope you had an enjoyable ride! before:2020/1/1 after:2019/1/1',
          // q: 'subject:(Your Grab E-Receipt) Hope you had an enjoyable ride!',
          q: config.gmail_query,
        }).then(messages => {
          let namespace = config.namespace;

          var dir = `extracted/${namespace}`;

          if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir);
          }
          console.log(namespace, messages.length);

          let csv_file_path = `${dir}/_${namespace}.csv`;

          let csvStream = null;
          if (csvStreams[csv_file_path]) { //re-use csvStream if same filename
            csvStream = csvStreams[csv_file_path];
          } else {
            csvStream = csv.format({ headers: true });
            csvStream.pipe(fs.createWriteStream(csv_file_path));
            csvStreams[csv_file_path] = csvStream;
          }

          const promises = [];

          messages.forEach(message => {
            let promise = get('messages', {
              userId: 'me',
              id: message['id'],
              format: 'full',
            }).then(data => {
              let payload = data.payload;
              let headers = payload.headers;
              let parts = payload.parts;

              let date_header = _.find(headers, { name: 'Date' });
              let date_str = date_header['value'];

              let date_moment = moment(date_str);

              // console.log(data);
              //   console.log(payload);
              //   console.log(headers)
              //   console.log(parts);

              ////// TRY TO EXTRACT HTML
              let base64_html_array = [];

              if (payload.mimeType == 'text/html') {
                base64_html_array.push(payload.body.data);
              }

              if (parts) {
                parts.forEach(part => {
                  // console.log(part);

                  if (part.mimeType == 'text/html') {
                    base64_html_array.push(part.body.data);
                  } else if (part.mimeType == 'multipart/alternative' || part.mimeType == 'multipart/related') {
                    part.parts.forEach(part => {
                      if (part.mimeType == 'text/html') {
                        base64_html_array.push(part.body.data);
                      }
                    });
                  }
                });
              }

              //   console.log(date_moment.format('YYYYMMDD_HHmmss'), message['id'], base64_html_array.length);
              let promises = [];

              ////// CONVERT HTML to PDFs
              base64_html_array.forEach(base64_html => {
                var html = Buffer.from(base64_html, 'base64').toString('ascii');

                let promise = limit(() => {
                  return browser.newPage().then(async page => {
                    await page.setContent(html);

                    let parser_result = await config.parser(page, html);

                    let output = {
                      namespace: namespace,
                      date: date_moment.format('YYYY-MM-DD HH:mm:ss'),
                      total: parser_result.total,
                      metadata: JSON.stringify(parser_result.metadata),
                    };
                    console.log(output);

                    csvStream.write(output);

                    if (headless) {
                      await page.pdf({
                        // path: `extracted/${message["id"]}.pdf`,
                        path: `extracted/${namespace}/${date_moment.format('YYYYMMDD_HHmmss')}-${parser_result.total || 'NA'}.pdf`,
                        format: 'A4',
                      });
                      await page.close();
                    }
                  });
                });
                promises.push(promise);
              });

              return Promise.all(promises);
            });

            promises.push(promise);
          });

          return Promise.all(promises);
        })
      );
    });

    await Promise.all(promises);

    console.timeEnd('Extraction');

    for (let csv_file_path in csvStreams) {
      let csvStream = csvStreams[csv_file_path];
      csvStream.end();
    }
    if (headless) {
      browser.close();
    }
  });
})();

/* 
let host = "imap.gmail.com";
let port = 993;
let options = {
  auth: {
    user: "hi@nickson.me",
    // pass: "Qazwex@0google"
    // xoauth2: access_token
    xoauth2:
      "ya29.a0Adw1xeV9sh7_v0VvuFwNgHnlZiKWaoVZqUXiZ9whU18QUiKpvPbbUKbQB8o1D29fOUERD-FL45KOI9fYn6C6DpdYRKpXXBtbToweoMwvClBrvGKBK6IDpAndFuvy66TkB-yj7mAaRA8s5IMo618Pqjm4pTtu2edagTk"
  },
  useSecureTransport: true
};

var client = new ImapClient(host, port, options);

console.log("Hello World");

client.connect().then(() => {
  client.listMailboxes().then(mailboxes => {
    console.log("mailboxes - ", mailboxes);
  });
});
 */
/* client.openConnection().then(capability => {
  console.log(capability);
    client.close();
}); */
