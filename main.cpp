#pragma once
#include "config.h"
#include "AUI/Common/AString.h"
#include "AUI/Common/AVector.h"
#include "AUI/Json/AJson.h"
#include "AUI/Thread/AFuture.h"
#include "AUI/Image/AImage.h"
#include "Endpoint.h"

struct StableDiffusionClient {
    Endpoint endpoint = config::ENDPOINT_SD;

    struct Txt2ImgRequest {
        AString prompt;
        AString negative_prompt;
        AVector<AString> styles;
        int64_t seed = -1;
        int64_t subseed = -1;
        double subseed_strength = 0;
        int64_t seed_resize_from_h = -1;
        int64_t seed_resize_from_w = -1;
        AString sampler_name = "DPM++ 2M";
        AString scheduler = "Automatic";
        AMap<AString, AString> override_settings {
            {"sd_model_checkpoint", config::SD_CHECKPOINT }
        };
        int64_t batch_size = 1;
        int64_t n_iter = 1;
        int64_t steps = 50;
        double cfg_scale = 2;
        int64_t width = 512;
        int64_t height = 512;
        bool send_images = true;
        bool save_images = false;
    };

    struct Txt2ImgResponse {
        AVector<_<AImage>> images;
        AJson info;
    };

    AFuture<Txt2ImgResponse> txt2img(const Txt2ImgRequest& request);
};
