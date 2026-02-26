async function test() {
    try {
        console.log("Fetching Ferdev API...");
        const apiRes = await fetch("https://api.ferdev.my.id/downloader/spotify?link=https%3A%2F%2Fopen.spotify.com%2Ftrack%2F1aHUscTJLMNcJvuiBtmgqA&apikey=fdv_pd0smcIACrw7J1-nDPKBoA");
        
        if (!apiRes.ok) {
            console.log("Ferdev API failed:", apiRes.status);
            return;
        }
        
        const apiData = await apiRes.json();
        const dlink = apiData.download || (apiData.data && apiData.data.download) || (apiData.data && apiData.data.url);
        
        console.log("Download link:", dlink);
        if (!dlink) {
            console.log("No download link found in data:", JSON.stringify(apiData, null, 2));
            return;
        }

        console.log("Fetching MP3...");
        const mp3Res = await fetch(dlink, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                'Accept': 'audio/mpeg, audio/*;q=0.9, */*;q=0.8',
            },
            signal: AbortSignal.timeout(10000)
        });
        
        console.log("MP3 Fetch Status:", mp3Res.status, mp3Res.statusText);
        
        if (!mp3Res.ok) {
        console.log("MP3 Fetch failed!");
        } else {
            console.log("MP3 content length:", mp3Res.headers.get("content-length"));
        }
    } catch (e) {
        console.error("Caught error:", e.message, e.cause || "");
    }
}
test();
