## Press Start?
run the development server:

```bash
npm run dev
# or
yarn dev
# or
pnpm dev
# or
bun dev
```

Open [http://localhost:3000](http://localhost:3000) with your browser to see the result.<br>
Or visit [`my-ftp-peerjs.vercel`](https://my-ftp-peerjs.vercel.app/) to see the demo.<br>
You can start editing the page by modifying `app/page.tsx`. The page auto-updates as you edit the file.

**This project was inspired from [filepizza](https://github.com/kern/filepizza)**

## Notes
Connection can only be done with **two** people only, for now. <br>
To establish connection, only one of you need to give your ID to be entered. <br>
Once connected you will be able to send message, file, or make a call. <br>


## My Notes
For full system analysis [Click Here](https://github.com/QA380/MyFTP-peerjs/wiki)

**Improvement to do:**
 *   Improve UI
      - Topbar rework

 *   Add more topbar function
      - Trusted device tab
      - Settings
      - Account
      - Documentation/help page

**Features to add / system-update:**
 * Account for repeated use
 * Settings page
 * Peer ID customization, and system rework
 * Separate chat and log
 * Network Optimization

 **Fix:**
 * ~~Inbox received double the notifaction for single file~~
 * ~~Toggling audio-video reset the connection~~
 * Ghost file appears, only 1 item sent yet 2 received but only 1 can be downloaded
 * Audio-Video did not terminated when call end
 * Cursor highlight when hover on files, highlight too bright
 * 
