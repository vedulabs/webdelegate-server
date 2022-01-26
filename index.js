import { WebSocketServer } from 'ws';
import queryString from 'query-string';
import puppeteer from 'puppeteer';
import { Writable, Readable } from 'stream';
import path from 'path';

const buttons = [
    'left',
    'middle',
    'right'
]


class MediaStream extends Writable {
    constructor({
        websocketConnection
    }) {
        super();
        this.websocketConnection = websocketConnection;
    }

    _write = (chunk, encoding, next) => {
        // console.log(chunk);
        this.websocketConnection.send(chunk);
        next();
    }
}

export class CaptureStream extends Readable {
    constructor(page, options) {
        super(options);
    }

    _read() {}

    async destroy(page = this.page) {
        super.destroy();
        await (page.browser().videoCaptureExtension).evaluate(
            (index) => {
                STOP_RECORDING(index);
            },
            page._id
        );
    }
}


const extensionPath = path.join(path.resolve(), 'extension');
const extensionId = 'foofdhnicbkplmcpgcnianionbjbbold';

function str2ab(str) {
    // Convert a UTF-8 String to an ArrayBuffer

    var buf = new ArrayBuffer(str.length); // 1 byte for each char
    var bufView = new Uint8Array(buf);

    for (var i = 0, strLen = str.length; i < strLen; i++) {
        bufView[i] = str.charCodeAt(i);
    }
    return buf;
}

async function getMediaStream(page, opts) {
    const encoder = new CaptureStream(page);
    if (!opts.audio && !opts.video) throw new Error("At least audio or video must be true");
    if (!opts.mimeType) {
        if (opts.video) opts.mimeType = 'video/webm';
        else if (opts.audio) opts.mimeType = 'audio/webm';
    }
    if (!opts.frameSize) opts.frameSize = 20;

    await page.bringToFront();

    await (page.browser().videoCaptureExtension).evaluate(
        (settings) => {
            START_RECORDING(settings);
        },
        { ...opts, index: page._id }
    );

    page.browser().encoders.set(page._id, encoder);

    return encoder;
}

const WebdelegateServer = ({
    expressServer,
}) => {
    const websocketServer = new WebSocketServer({
        noServer: true,
        path: '/renderer',
    });

    expressServer.on('upgrade', (request, socket, head) => {
        websocketServer.handleUpgrade(request, socket, head, (websocket) => {
            websocketServer.emit('connection', websocket, request);
        });
    });

    websocketServer.on(
        'connection',
        function connection(websocketConnection, connectionRequest) {

            let browser = null;
            let page = null;
            let stream = null;
            let session = null;

            websocketConnection.on('close', async (reasonCode, description) => {
                console.log('Connection closed');
                if (browser && page) {
                    await page.close();
                    await browser.close();
                }
            });

            console.log(`New connection from ${connectionRequest.socket.remoteAddress.replace(/^.*:/, '')}`);

            // console.log(websocketConnection);
            // console.log(connectionRequest);

            const [_path, params] = connectionRequest?.url?.split('?');
            const connectionParams = queryString.parse(params);

            // NOTE: connectParams are not used here but good to understand how to get
            // to them if you need to pass data with the connection to identify it (e.g., a userId).
            console.log(connectionParams);
            console.log(`Extension path: ${extensionPath}`);

            (async () => {
                browser = await puppeteer.launch({
                    headless: false,
                    defaultViewport: null,
                    args: [
                        '--single-process', 
                        '--no-sandbox', 
                        '--no-zygote',
                        '--use-angle=default',

                        // '--ignore-gpu-blacklist',
                        // '--enable-zero-copy',
                        // '--enable-native-gpu-memory-buffers',
                        // '--disable-background-timer-throttling',

                        '--autoplay-policy=no-user-gesture-required',
                        '--start-fullscreen',

                        '--load-extension=' + extensionPath,
                        '--disable-extensions-except=' + extensionPath,
                        '--whitelisted-extension-id=' + extensionId
                    ],
                    ignoreDefaultArgs: [
                        '--hide-scrollbars',
                    ]
                });

                browser.encoders = new Map();

                const targets = await browser.targets();
                // console.log(targets);
                const backgroundPageTarget = targets.find(target => target.type() === 'background_page' && target.url().startsWith(`chrome-extension://${extensionId}/`));
                browser.videoCaptureExtension = await backgroundPageTarget.page();
                await browser.videoCaptureExtension.exposeFunction('sendData', (opts) => {
                    const data = Buffer.from(str2ab(opts.data));
                    browser.encoders.get(opts.id).push(data);
                });

                browser.on('targetcreated', async function f(){
                    let pages = await browser.pages();
                    if (pages.length > 1) {
                        await pages[0].close();
                        browser.off('targetcreated', f);
                    }
                });

                page = await browser.newPage();
                await page.setViewport({
                    width: parseInt(connectionParams.target_width),
                    height: parseInt(connectionParams.target_height)
                });

                await page.goto(Buffer.from(connectionParams.target_url, 'base64').toString());
                // await page.waitForNavigation(1000);


                stream = await getMediaStream(page, {
                    audio: true,
                    video: false,
                    frameSize: 20,
                    mimeType: 'audio/webm; codecs=opus'
                });

                const mediaStream = new MediaStream({
                    websocketConnection,
                });
                stream.pipe(mediaStream);



                session = await page.target().createCDPSession();
                session.on('Page.screencastFrame', async (event) => {
                    websocketConnection.send(JSON.stringify({
                        frame: event.data,
                    }));
                    await session.send('Page.screencastFrameAck', { sessionId: event.sessionId });
                });
                await session.send('Page.startScreencast', {
                    format: 'jpeg',
                    quality: 35,
                    everyNthFrame: connectionParams.every_nth_frame ? parseInt(connectionParams.every_nth_frame) : 10,
                })
                .catch(() => {});

                // const { windowId } = await session.send('Browser.getWindowForTarget');
                // await session.send('Browser.setWindowBounds', {
                //     windowId, 
                //     bounds: {
                //         windowState: 'minimized'
                //     }
                // });

            })();

            websocketConnection.on('message', async (message) => {
                if (page) {
                    const parsedMessage = JSON.parse(message);

                    if (parsedMessage.category === 'event') {
                        switch(parsedMessage.data.type) {
                            case 'mousedown':
                                await page.mouse.down({
                                    button: buttons[parseInt(parsedMessage.data.button)]
                                });
                                break;
                            case 'mousemove':
                                const x = parsedMessage.data.x;
                                const y = parsedMessage.data.y;
                                await await page.mouse.move(x, y);
                                const cursor = await page.evaluate((x, y) => {
                                    const element = document.elementFromPoint(x, y);
                                    if (element) {
                                        const computedStyle = window.getComputedStyle(element);
                                        return computedStyle.cursor;
                                    }
                                }, x, y);
                                if (cursor) {
                                    websocketConnection.send(JSON.stringify({
                                        cursor
                                    }));
                                }
                                break;
                            case 'mouseup':
                                await await page.mouse.up();
                                break;
                            case 'resize':
                                await page.setViewport({
                                    width: parseInt(parsedMessage.data.w),
                                    height: parseInt(parsedMessage.data.h)
                                });
                                break;
                            case 'wheel':
                                await page.mouse.wheel({ deltaY: parsedMessage.data.delta });
                                break;
                            case 'keydown':
                                await page.keyboard.down(parsedMessage.data.key);
                                break;
                            case 'keyup':
                                await page.keyboard.up(parsedMessage.data.key);
                                break;
                        }

                        // const screenshot = await page.screenshot({ encoding: 'base64' });
                        // websocketConnection.send(JSON.stringify({
                        //     frame: screenshot,
                        // }));
                        // console.log(`${Date.now()} frame sent`);

                    } else if (parsedMessage.category === 'command') {
                        switch(parsedMessage.data.type) {
                            case 'history':
                                if (parsedMessage.data.value === 'back') {
                                    await page.goBack();
                                }
                                break;
                        }
                    }
                }

            });
        }
    );

    return websocketServer;
}

export default WebdelegateServer;