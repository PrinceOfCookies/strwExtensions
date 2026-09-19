# strwBalt
> cobalt.tools, but it's an extension!
> <img src="icon512.png" align="right" style="width:150px; height:auto;"/>

this extension allows you to download media from all sorts of websites. the support list is the same as cobalt.tools, only that I made sure it can also download youtube media as well. it allows you to configure everything directly with no hastle.

## installation
this installation is a little bit complicated as it requires you to have docker and setup WSL
1. install Windows Subsystem for Linux (WSL) on your machine by opening powershell as an administrator and running the command below. you may skip this if you're on mac.
```powershell
wsl --install
```
2. download [docker desktop](https://www.docker.com/products/docker-desktop/)
3. setup docker desktop by logging into it and configure it if you want
4. download this section of the repository
5. double click the .bat file and wait for it to install. if you're on mac, you need to run it via the terminal with the following commands:
```
chmod +x install.sh check.sh uninstall.sh
./install.sh
```
6. go to the extensions of your browser and turn on developer mode
7. press "Load Unpacked" and select the folder titled "extension" and import that

boom! your extension should be working! if any of the dots are red, please ensure the docker container is running. if theres any issues please contact me via WFHpExKKnsngRstw@simao.me

> [!TIP]
> WSL/docker use a lot of system resources by default. I would recommend configuring these. on windows you can customise this by opening "WSL Settings" by searching for it on the app search, and on mac you can configure this directly by going to docker settings and resources. 1 GB of RAM and 1 core should be enough.
