import { DateTime } from "luxon";
import axios, { AxiosResponse } from "axios";
import { ConfigData, MainCallbackType } from "../../shared/types";

export class ConfigHandler {
    readonly runApp = (_callbackParams: MainCallbackType): Promise<void> => {
        return Promise.resolve();
    };
    readonly codeChangeInterval = 12.5;

    config: ConfigData;

    $configPanel: HTMLElement | null | undefined;
    $configPanelLoader: HTMLElement | undefined;
    $configPanelCode: HTMLElement | undefined;
    $configPanelManual: HTMLElement | undefined;
    $configPanelError: HTMLElement | undefined;
    $useCodeButton: HTMLButtonElement | undefined;
    $manualConnectButton: HTMLButtonElement | undefined;
    $activePage: HTMLElement | undefined;
    $inactivePage: HTMLElement | undefined;
    $unavailableCode: HTMLElement | undefined;
    codeInterval: NodeJS.Timeout | undefined;
    slideIndex: number;
    timeoutId: NodeJS.Timeout | undefined;

    constructor(config: ConfigData, runApp: ({ context }: MainCallbackType) => Promise<void>) {
        this.config = config;
        this.slideIndex = 0;
        this.runApp = runApp;

        console.debug('ConfigHandler initialized', {
            config: this.config,
        });
    }

    init() {
        // Elements involved in the config panel.
        this.$configPanel = document.getElementById('config');
        this.$configPanelLoader = (<HTMLElement>this.$configPanel!.querySelector('#config-loader'));
        this.$configPanelCode = (<HTMLElement>this.$configPanel!.getElementsByClassName('activation-container')[0]);
        this.$configPanelManual = (<HTMLElement>this.$configPanel!.getElementsByClassName('config-container')[0]);
        this.$configPanelError = (<HTMLElement>this.$configPanel!.getElementsByClassName('error')[0]);
        this.$activePage = (<HTMLElement>this.$configPanel!.getElementsByClassName('active-page')[0]);
        this.$inactivePage = (<HTMLElement>this.$configPanel!.getElementsByClassName('inactive-page')[0]);
        this.$unavailableCode = (<HTMLElement>this.$configPanel!.getElementsByClassName('unavailable-code')[0]);

        this.$configPanel!.style.display = 'flex';
        this.$inactivePage?.style.setProperty('display', 'none');
        this.$unavailableCode?.style.setProperty('display', 'none');

        this.$useCodeButton = document.querySelector('button[data-target="activation-code"]') as HTMLButtonElement;
        const handleUseCodeButton = async (evt: Event) => {
            evt.preventDefault();
            const target = evt.target as HTMLButtonElement;

            (target) && target?.classList.add('active');
            (this.$manualConnectButton) && this.$manualConnectButton.classList.remove('active');

            this.$configPanelManual!.style.display = 'none';
            this.$configPanelCode!.style.display = 'grid';
            this.$configPanelError!.textContent = '';
            // this.$configPanelError!.style.display = 'none';

            await this.run();
        };
        this.$manualConnectButton = document.querySelector('button[data-target="configure-manually"]') as HTMLButtonElement;
        const handleManualConnectButton = (evt: Event) => {
            evt.preventDefault();
            const target = evt.target as HTMLButtonElement;

            (target) && target?.classList.add('active');
            (this.$useCodeButton) && this.$useCodeButton.classList.remove('active');

            this.handleManualConnect();

            if (this.codeInterval) clearInterval(this.codeInterval);
        }

        this.$useCodeButton!.removeEventListener('click', handleUseCodeButton);
        this.$useCodeButton!.addEventListener('click', handleUseCodeButton);

        this.$manualConnectButton!.removeEventListener('click', handleManualConnectButton);
        this.$manualConnectButton!.addEventListener('click', handleManualConnectButton);

        const $retryUseCodeBtn = document.getElementById('retry-use-code');
        const handleRetryUseCode = async (evt: Event) => {
            evt.preventDefault();

            this.$configPanelCode!.style.display = 'grid';
            this.$configPanelError!.textContent = '';

            await this.run();
        };

        $retryUseCodeBtn?.removeEventListener('click', handleRetryUseCode);
        $retryUseCodeBtn?.addEventListener('click', handleRetryUseCode);


        const manualSubmitButton = document.getElementById('manualSubmitButton');

        // Listen to the submit button being pressed.
        manualSubmitButton!.removeEventListener('click', this.handleManualSubmitButton);
        manualSubmitButton!.addEventListener('click', this.handleManualSubmitButton.bind(this));

        // Init slides
        this.showSlides();

        // Populate config page details section
        this.setConfigDetails();
    }

    handleManualSubmitButton(evt: Event) {
        evt.preventDefault();
        const $submitBtn = evt.target as HTMLInputElement;

        $submitBtn.disabled = true;
        this.$configPanelLoader?.style.setProperty('display', 'block');
        // this.$configPanelManual!.style.display = 'none';
        this.$configPanelError!.textContent = '';

        // Check connection.
        this.config.cmsKey = (<HTMLInputElement>document.getElementsByName('cms-key')[0]).value;
        this.config.displayName = (<HTMLInputElement>document.getElementsByName('display-name')[0]).value;
        this.config.cmsUrl = (<HTMLInputElement>document.getElementsByName('cms-address')[0]).value;

        this.handleRegisterDisplayCallback()
            .finally(() => {
                $submitBtn.disabled = false;
                this.$configPanelLoader?.style.setProperty('display', 'none');
                this.$configPanelManual?.style.setProperty('display', 'grid');
            });
    }

    async handleRegisterDisplayCallback() {
        try {
            await window.apiHandler.xmdsTryRegister(this.config);

            // Close the config panel.
            this.$configPanel?.style.setProperty('display', 'none');
            await this.runApp({ context: 'main' });
        } catch (error) {
            console.debug('[ConfigHandler::handleRegisterDisplayCallback]', error);

            const reqError = error;

            if (reqError instanceof Error) {
                this.$configPanelError!.textContent = reqError.message;
            } else {
                console.debug(reqError);
            }
        }
    }

    handleCodeInterval(response: { data: { user_code: string; device_code: string } }) {
        console.debug(response);

        this.$configPanelCode?.style.setProperty('display', 'grid');
        this.$configPanelManual?.style.setProperty('display', 'none');
        this.$activePage?.style.setProperty('display', 'flex');
        this.$inactivePage?.style.setProperty('display', 'none');
        this.$unavailableCode?.style.setProperty('display', 'none');

        const $configPanelCodeText = (<HTMLElement>this.$configPanelCode!.getElementsByTagName('code')[0]);
        const $hideCodeCheckbox = (<HTMLInputElement>this.$configPanelCode!.querySelector('.hide-code--wrapper input[type="checkbox"]'))

        $configPanelCodeText.textContent = response.data.user_code;

        if ($hideCodeCheckbox) {
            $hideCodeCheckbox.checked = false;
        }

        this.hideCodeCheckboxHandler($configPanelCodeText.textContent);

        // Periodic polling to get the device code and configure the connection.
        this.codeInterval = setInterval(() => {
            axios.get('https://auth.signlicence.co.uk/getDetails?user_code='
                + response.data.user_code + "&device_code=" + response.data.device_code)
                .then(async (response: AxiosResponse) => {
                    console.debug(response.data);

                    // If we get a message back, continue on.
                    if (response.data.message) {
                        return;
                    }

                    clearInterval(this.codeInterval);

                    // The response should contain the cmsKey.
                    this.config.cmsKey = response.data.cmsKey;
                    this.config.cmsUrl = response.data.cmsAddress;
                    this.config.displayName = this.config.displayName + ' Linux player';

                    console.debug('ConfigHandler::handleCodeInterval - Got config from code polling', {
                        cmsKey: this.config.cmsKey,
                        cmsUrl: this.config.cmsUrl,
                    });
                    await this.handleRegisterDisplayCallback();
                });
        }, this.codeChangeInterval * 1000);
    }

    handleManualConnect() {
        // Show manual configuration instead.
        this.$activePage?.style.setProperty('display', 'flex');
        this.$inactivePage?.style.setProperty('display', 'none');
        this.$configPanelCode?.style.setProperty('display', 'none');
        this.$configPanelManual?.style.setProperty('display', 'grid');

        const $hideCmsKeyCheckbox = (<HTMLInputElement>this.$configPanelCode!.querySelector('.hide-cmsKey--wrapper input[type="checkbox"]'))

        if ($hideCmsKeyCheckbox) {
            $hideCmsKeyCheckbox.checked = false;
        }

        this.hideCmsKeyCheckboxHandler();
    }

    async run() {
        await this.licenseGenerateCode()
            .catch((error) => {
                console.debug(error);

                this.$activePage?.style.setProperty('display', 'none');
                this.$inactivePage?.style.setProperty('display', 'block');
                this.$unavailableCode?.style.setProperty('display', 'flex');
            });
    }

    async licenseGenerateCode() {
        return axios.post('https://auth.signlicence.co.uk/generateCode', {
            hardwareId: this.config.hardwareKey,
            type: 'linux',
            version: this.config.version
        })
            .then((response) => {
                console.debug('ConfigHandler::licenseGenerateCode', response);
                this.handleCodeInterval(response);
            });
    }

    hideCodeCheckboxHandler(activationCode: string | null) {
        const $hideCodeElm = (<HTMLElement>this.$configPanel!.querySelector('.hide-code--wrapper'));
        const $hideCodeCheckbox = (<HTMLInputElement>$hideCodeElm!.querySelector('input[type="checkbox"]'));
        const $hideCodeText = (<HTMLElement>this.$configPanel!.querySelector('code.code-text'));

        $hideCodeCheckbox.addEventListener("change", function () {
            if (this.checked) {
                $hideCodeText.textContent = "••••••";
            } else {
                $hideCodeText.textContent = activationCode;
            }
        });
    }

    hideCmsKeyCheckboxHandler() {
        const $hideCmsKeyElm = (<HTMLElement>this.$configPanel!.querySelector('.hide-cmsKey--wrapper'));
        const $hideCmsKeyCheckbox = (<HTMLInputElement>$hideCmsKeyElm!.querySelector('input[type="checkbox"]'));
        const $cmsKeyInput = (<HTMLInputElement>document.getElementsByName('cms-key')[0]);

        $hideCmsKeyCheckbox.addEventListener("change", function () {
            $cmsKeyInput.type = this.checked ? 'password' : 'text';
        });
    }

    showSlides() {
        const self = this;
        let slides = Array.from(<HTMLCollectionOf<HTMLElement>>document!.getElementsByClassName("mySlides"));
        let dots = Array.from(<HTMLCollectionOf<HTMLElement>>document!.getElementsByClassName("dot"));

        (async () => await Promise.all(slides.map((slide) => slide.style.display = 'none')))();

        this.slideIndex++;
        if (this.slideIndex > slides.length) {
            this.slideIndex = 1;
        }

        (async () => await Promise.all(dots.map((dot, dotIndex) => {
            const dotSlide = parseInt(dot.dataset.slide ?? String(dotIndex + 1));
            dot.classList.remove('active');
            dot.addEventListener('click', () => this.currentSlide.apply(this, [dotSlide]));
        })))();

        const currSlideIndex = this.slideIndex - 1;

        (Boolean(slides[currSlideIndex])) && slides[currSlideIndex].style.setProperty('display', 'block');
        (Boolean(dots[currSlideIndex])) && dots[currSlideIndex].classList.add('active');

        self.timeoutId = setTimeout(this.showSlides.bind(self), 5000);
    }

    currentSlide(n: number) {
        this.slideIndex = n;

        if (this.timeoutId !== undefined) {
            clearTimeout(this.timeoutId);
        }

        this.showSlides();
    }

    setConfigDetails() {
        const $dateTimeTxt = (<HTMLElement>this.$configPanel!.querySelector('#date-time--text'));
        const $dateTimeTxt2 = (<HTMLElement>this.$configPanel!.querySelector('#date-time--text2'));

        const dateTimeNow = DateTime.now().toFormat('FF');

        if ($dateTimeTxt) {
            $dateTimeTxt.textContent = dateTimeNow;
        }

        if ($dateTimeTxt2) {
            $dateTimeTxt2.textContent = dateTimeNow;
        }
    }
}