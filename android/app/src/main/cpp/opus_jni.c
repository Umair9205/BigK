#include <jni.h>
#include <stdlib.h>
#include <string.h>

#include "opus.h"

static OpusEncoder *g_encoder = NULL;
static OpusDecoder *g_decoder = NULL;
static int g_channels = 1;
static int g_sample_rate = 16000;

static jbyteArray makeByteArray(JNIEnv *env, jint length) {
    if (length <= 0) {
        length = 1;
    }
    jbyteArray result = (*env)->NewByteArray(env, length);
    if (result == NULL) {
        return NULL;
    }
    jbyte *buffer = (jbyte *)calloc((size_t)length, sizeof(jbyte));
    if (buffer == NULL) {
        return result;
    }
    (*env)->SetByteArrayRegion(env, result, 0, length, buffer);
    free(buffer);
    return result;
}

static jshortArray makeShortArray(JNIEnv *env, jint length) {
    if (length <= 0) {
        length = 1;
    }
    jshortArray result = (*env)->NewShortArray(env, length);
    if (result == NULL) {
        return NULL;
    }
    jshort *buffer = (jshort *)calloc((size_t)length, sizeof(jshort));
    if (buffer == NULL) {
        return result;
    }
    (*env)->SetShortArrayRegion(env, result, 0, length, buffer);
    free(buffer);
    return result;
}

JNIEXPORT jint JNICALL Java_com_anonymous_kelakonnect_OpusModule__1initEncoder(
    JNIEnv *env,
    jobject thiz,
    jint sampleRate,
    jint channels,
    jint bitrate) {
    (void)env;
    (void)thiz;

    if (g_encoder != NULL) {
        opus_encoder_destroy(g_encoder);
        g_encoder = NULL;
    }

    g_channels = channels > 0 ? channels : 1;
    g_sample_rate = sampleRate > 0 ? sampleRate : 16000;

    int error = 0;
    g_encoder = opus_encoder_create(g_sample_rate, g_channels, OPUS_APPLICATION_VOIP, &error);
    if (g_encoder == NULL) {
        return error;
    }

    if (bitrate > 0) {
        error = opus_encoder_ctl(g_encoder, OPUS_SET_BITRATE(bitrate));
        if (error != OPUS_OK) {
            opus_encoder_destroy(g_encoder);
            g_encoder = NULL;
            return error;
        }
    }

    return 0;
}

JNIEXPORT jint JNICALL Java_com_anonymous_kelakonnect_OpusModule__1initDecoder(
    JNIEnv *env,
    jobject thiz,
    jint sampleRate,
    jint channels) {
    (void)env;
    (void)thiz;

    if (g_decoder != NULL) {
        opus_decoder_destroy(g_decoder);
        g_decoder = NULL;
    }

    g_channels = channels > 0 ? channels : 1;
    g_sample_rate = sampleRate > 0 ? sampleRate : 16000;

    int error = 0;
    g_decoder = opus_decoder_create(g_sample_rate, g_channels, &error);
    if (g_decoder == NULL) {
        return error;
    }

    return 0;
}

JNIEXPORT jbyteArray JNICALL Java_com_anonymous_kelakonnect_OpusModule_encodeOpus(
    JNIEnv *env,
    jobject thiz,
    jshortArray pcmSamples,
    jint sampleCount) {
    (void)thiz;

    if (pcmSamples == NULL || g_encoder == NULL) {
        return NULL;
    }

    jsize length = (*env)->GetArrayLength(env, pcmSamples);
    if (length <= 0) {
        return NULL;
    }

    jshort *pcm = (*env)->GetShortArrayElements(env, pcmSamples, NULL);
    if (pcm == NULL) {
        return NULL;
    }

    int frame_size = sampleCount > 0 ? sampleCount : length;
    int max_encoded = (frame_size + 1) * 2;
    unsigned char *encoded = (unsigned char *)calloc((size_t)max_encoded, sizeof(unsigned char));
    if (encoded == NULL) {
        (*env)->ReleaseShortArrayElements(env, pcmSamples, pcm, JNI_ABORT);
        return NULL;
    }

    int encoded_len = opus_encode(g_encoder, pcm, frame_size, encoded, max_encoded);
    (*env)->ReleaseShortArrayElements(env, pcmSamples, pcm, JNI_ABORT);

    if (encoded_len < 0) {
        free(encoded);
        return NULL;
    }

    jbyteArray result = (*env)->NewByteArray(env, encoded_len);
    if (result == NULL) {
        free(encoded);
        return NULL;
    }

    (*env)->SetByteArrayRegion(env, result, 0, encoded_len, (const jbyte *)encoded);
    free(encoded);
    return result;
}

JNIEXPORT jshortArray JNICALL Java_com_anonymous_kelakonnect_OpusModule_decodeOpus(
    JNIEnv *env,
    jobject thiz,
    jbyteArray opusBytes,
    jint dataLength,
    jint frameSize) {
    (void)thiz;

    if (opusBytes == NULL || g_decoder == NULL) {
        return NULL;
    }

    jsize opus_len = (*env)->GetArrayLength(env, opusBytes);
    int decoded_frame = frameSize > 0 ? frameSize : 320;
    // A zero-length packet requests Opus packet-loss concealment.
    jbyte *opus_data = opus_len > 0 ? (*env)->GetByteArrayElements(env, opusBytes, NULL) : NULL;
    if (opus_len > 0 && opus_data == NULL) {
        return NULL;
    }

    short *pcm_out = (short *)calloc((size_t)decoded_frame, sizeof(short));
    if (pcm_out == NULL) {
        if (opus_data) (*env)->ReleaseByteArrayElements(env, opusBytes, opus_data, JNI_ABORT);
        return NULL;
    }

    int out_count = opus_decode(g_decoder, (const unsigned char *)opus_data, (opus_int32)opus_len, pcm_out, decoded_frame, 0);
    if (opus_data) (*env)->ReleaseByteArrayElements(env, opusBytes, opus_data, JNI_ABORT);

    if (out_count < 0) {
        free(pcm_out);
        return NULL;
    }

    jshortArray result = (*env)->NewShortArray(env, out_count);
    if (result == NULL) {
        free(pcm_out);
        return NULL;
    }

    (*env)->SetShortArrayRegion(env, result, 0, out_count, pcm_out);
    free(pcm_out);
    return result;
}
