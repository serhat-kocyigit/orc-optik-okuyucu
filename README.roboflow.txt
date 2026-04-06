
Bubble Answer Sheet - v5 2025-03-28 7:28am
==============================

This dataset was exported via roboflow.com on August 9, 2025 at 9:31 AM GMT

Roboflow is an end-to-end computer vision platform that helps you
* collaborate with your team on computer vision projects
* collect & organize images
* understand and search unstructured image data
* annotate, and create datasets
* export, train, and deploy computer vision models
* use active learning to improve your dataset over time

For state of the art Computer Vision training notebooks you can use with this dataset,
visit https://github.com/roboflow/notebooks

To find over 100k other datasets and pre-trained models, visit https://universe.roboflow.com

The dataset includes 12000 images.
Tests-Paper are annotated in Tensorflow Object Detection format.

The following pre-processing was applied to each image:
* Resize to 1024x1024 (Stretch)
* Grayscale (CRT phosphor)

The following augmentation was applied to create 3 versions of each source image:
* Random rotation of between -4 and +4 degrees
* Random shear of between -2° to +2° horizontally and -2° to +2° vertically
* Random brigthness adjustment of between -19 and +19 percent
* Random exposure adjustment of between -13 and +13 percent
* Salt and pepper noise was applied to 0.12 percent of pixels


